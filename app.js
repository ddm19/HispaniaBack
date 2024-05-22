const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 8080;

app.get('/', (req, res) => {
    res.send('Hello World!');
});
const cors = require('cors');
const corsOptions = {
    origin: 'http://localhost:3000',
    credentials: true,
    optionSuccessStatus: 200
}
app.use(cors(corsOptions));
app.get('/articles', (req, res) => {
    const articlesDir = path.join(__dirname, 'articles');

    fs.readdir(articlesDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to scan directory' });
        }

        const jsonFiles = files.filter(file => path.extname(file) === '.json');

        if (jsonFiles.length === 0) {
            return res.status(404).json({ error: 'No JSON files found' });
        }

        const articles = jsonFiles.map(file => {
            const filePath = path.join(articlesDir, file);
            const fileContent = fs.readFileSync(filePath, 'utf8');
            return {
                name: path.basename(file, '.json'),
                content: JSON.parse(fileContent)
            };
        });

        res.json(articles);
    });
});

app.get('/articles/:id', (req, res) => {
    const id = req.params.id;
    const filePath = path.join(__dirname, 'articles', `${id}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `File with ID ${id} not found` });
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const article = JSON.parse(fileContent);
        res.json(article);
    } catch (err) {
        res.status(500).json({ error: 'Error reading the file' });
    }
});


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
