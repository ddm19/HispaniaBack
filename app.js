const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
const path = require('path');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Readable } = require('stream');

dotenv.config();

const app = express();
const port = 8080;

app.use(bodyParser.json());



// Bearer Token
app.use((req, res, next) => {
    let token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    }
    if (token !== process.env.BEARER_TOKEN) {
        console.log('Unauthorized access with token:' + token);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});



app.use(cors());


const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const bucketName = process.env.S3_BUCKET_NAME;


app.get('/articles', async (req, res) => {
    const params = {
        Bucket: bucketName
    };

    try {
        const data = await s3Client.send(new ListObjectsV2Command(params));
        const jsonFiles = data.Contents.filter(item => item.Key.endsWith('.json'));

        if (jsonFiles.length === 0) {
            return res.status(404).json({ error: 'No JSON files found' });
        }

        const articlesPromises = jsonFiles.map(async file => {
            const getObjectParams = {
                Bucket: bucketName,
                Key: file.Key
            };
            const command = new GetObjectCommand(getObjectParams);
            const data = await s3Client.send(command);
            const streamToString = (stream) => new Promise((resolve, reject) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('error', reject);
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            const fileContent = await streamToString(data.Body);

            return {
                name: file.Key.replace('.json', ''),
                content: JSON.parse(fileContent)
            };
        });

        const articles = await Promise.all(articlesPromises);
        res.json(articles);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching articles from S3' });
    }
});

app.get('/articles/:id', async (req, res) => {
    const id = req.params.id;
    const fileKey = `${id}.json`;

    const params = {
        Bucket: bucketName,
        Key: fileKey
    };

    try {
        const data = await s3Client.send(new GetObjectCommand(params));
        const streamToString = (stream) => new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        const fileContent = await streamToString(data.Body);
        const article = JSON.parse(fileContent);
        res.json(article);
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            return res.status(404).json({ error: `File with ID ${id} not found` });
        }
        console.error(err);
        res.status(500).json({ error: 'Error fetching the file from S3' });
    }
});

app.post('/articles/:name', async (req, res) => {
    const name = req.params.name;
    const fileKey = `${name}.json`;
    const article = req.body;

    const putObjectParams = {
        Bucket: bucketName,
        Key: fileKey,
        Body: JSON.stringify(article, null, 2),
        ContentType: 'application/json'
    };

    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
        return res.status(400).json({ error: `File with name ${name} already exists` });
    } catch (err) {
        if (err.name !== 'NotFound') {
            console.error(err);
            return res.status(500).json({ error: 'Error checking if file exists in S3' });
        }
    }

    try {
        await s3Client.send(new PutObjectCommand(putObjectParams));
        res.status(201).json({ message: 'Article created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error writing the file to S3' });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
