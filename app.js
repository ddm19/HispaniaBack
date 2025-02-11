const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { 
    S3Client, 
    ListObjectsV2Command, 
    GetObjectCommand, 
    PutObjectCommand, 
    HeadObjectCommand, 
    DeleteObjectCommand 
} = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
const { Readable } = require('stream');

dotenv.config();

const app = express();
const port = 8080;

app.use(bodyParser.json());

// Middleware para Bearer Token
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    let token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    }
    if (token !== process.env.BEARER_TOKEN) {
        console.log('Unauthorized access with token:', token);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// CORS
const corsOptions = {
    origin: '*',
    credentials: true,
    optionSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const bucketName = process.env.S3_BUCKET_NAME;

// Función auxiliar para convertir un stream S3 a string
const streamToString = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

// GET: Listar todos los artículos
app.get('/articles', async (req, res) => {
    try {
        const data = await s3Client.send(new ListObjectsV2Command({ Bucket: bucketName }));
        if (!data.Contents) return res.status(404).json({ error: 'No articles found' });

        const jsonFiles = data.Contents.filter(item => item.Key.endsWith('.json'));
        const articles = await Promise.all(jsonFiles.map(async file => {
            const fileData = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: file.Key }));
            return { id: file.Key.replace('.json', ''), content: JSON.parse(await streamToString(fileData.Body)) };
        }));

        res.json(articles);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching articles from S3' });
    }
});

// GET: Obtener un artículo específico
app.get('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;

    try {
        const data = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: fileKey }));
        res.json(JSON.parse(await streamToString(data.Body)));
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            return res.status(404).json({ error: `Article with ID ${req.params.id} not found` });
        }
        console.error(err);
        res.status(500).json({ error: 'Error fetching article from S3' });
    }
});

// POST: Crear un nuevo artículo
app.post('/articles', async (req, res) => {
    const article = req.body;
    
    if (!article.title) {
        return res.status(400).json({ error: 'Article title is required' });
    }
    
    const fileKey = `${article.title}.json`;

    try {
        // Verifica si ya existe un artículo con ese id
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
        return res.status(400).json({ error: `Article with id ${article.title} already exists` });
    } catch (err) {
        if (err.name !== 'NotFound') {
            console.error(err);
            return res.status(500).json({ error: 'Error checking if article exists in S3' });
        }
    }

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            Body: JSON.stringify(article, null, 2),
            ContentType: 'application/json'
        }));
        res.status(201).json({ message: 'Article created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error writing article to S3' });
    }
});

// PUT: Actualizar un artículo existente
app.put('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;
    const updatedArticle = req.body;

    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
    } catch (err) {
        if (err.name === 'NotFound') {
            return res.status(404).json({ error: `Article with ID ${req.params.id} not found` });
        }
        console.error(err);
        return res.status(500).json({ error: 'Error checking article existence in S3' });
    }

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            Body: JSON.stringify(updatedArticle, null, 2),
            ContentType: 'application/json'
        }));
        res.json({ message: 'Article updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error updating article in S3' });
    }
});

// DELETE: Eliminar un artículo
app.delete('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;

    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
    } catch (err) {
        if (err.name === 'NotFound') {
            return res.status(404).json({ error: `Article with ID ${req.params.id} not found` });
        }
        console.error(err);
        return res.status(500).json({ error: 'Error checking article existence in S3' });
    }

    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileKey }));
        res.json({ message: 'Article deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error deleting article from S3' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
