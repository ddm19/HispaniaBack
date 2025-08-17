const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');

const cors = require('cors');
const {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = 8080;

app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));

// Middleware para Bearer Token
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    let token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    }
    if (token !== process.env.BEARER_TOKEN) {
        console.log('Unauthorized access with token:', token);
        return res.status(401).json({ error: 'No autorizado' });
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
        if (!data.Contents) return res.status(404).json({ error: 'No se encontraron artículos' });

        const jsonFiles = data.Contents.filter(item => item.Key.endsWith('.json'));
        const articles = await Promise.all(jsonFiles.map(async file => {
            const fileData = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: file.Key }));
            const parsed = JSON.parse(await streamToString(fileData.Body));
            return { id: file.Key.replace('.json', ''), content: parsed.article || parsed };
        }));

        res.json(articles);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error obteniendo artículos de S3' });
    }
});


// GET: Obtener un artículo específico
app.get('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;

    try {
        const data = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: fileKey }));
        const parsed = JSON.parse(await streamToString(data.Body));
        return res.json(parsed.article || parsed);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
            return res.status(404).json({ error: `Artículo con ID ${req.params.id} no encontrado` });
        }
        console.error(err);
        res.status(500).json({ error: 'Error obteniendo el artículo de S3' });
    }
});

// POST: Crear un nuevo artículo
app.post('/articles', async (req, res) => {
    const { articleJSON } = req.body || {};
    const rawPassword = req.body?.password;

    if (!articleJSON || !articleJSON.title) {
        return res.status(400).json({ error: 'Se requiere el título del artículo' });
    }
    if (rawPassword === undefined || rawPassword === null) {
        return res.status(400).json({ error: 'Se requiere una contraseña válida (mín. 4 caracteres)' });
    }

    const password = String(rawPassword);
    if (password.trim().length < 4) {
        return res.status(400).json({ error: 'Se requiere una contraseña válida (mín. 4 caracteres)' });
    }

    const fileKey = `${articleJSON.title}.json`;

    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
        return res.status(400).json({ error: `El artículo con id ${articleJSON.title} ya existe` });
    } catch (err) {
        if (err.name !== 'NotFound') {
            console.error(err);
            return res.status(500).json({ error: 'Error comprobando si el artículo existe en S3' });
        }
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const storedPayload = {
            article: articleJSON,
            passwordHash,
        };

        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            Body: JSON.stringify(storedPayload, null, 2),
            ContentType: 'application/json'
        }));

        res.status(201).json({ message: 'Artículo creado correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al escribir el artículo en S3' });
    }
});

// PUT: Actualizar un artículo existente

app.put('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;
    const rawPassword = req.body?.password;

    if (rawPassword === undefined || rawPassword === null) {
        return res.status(400).json({ error: 'Se requiere contraseña' });
    }

    const password = String(rawPassword);

    try {
        const { Body } = await s3Client.send(
            new GetObjectCommand({ Bucket: bucketName, Key: fileKey })
        );
        const existing = JSON.parse(await Body.transformToString());

        if (!existing.passwordHash || typeof existing.passwordHash !== 'string') {
            return res.status(409).json({ error: 'El artículo fue creado sin contraseña. Por favor, migrelo primero.' });
        }

        const ok = await bcrypt.compare(password, existing.passwordHash);
        if (!ok) return res.status(403).json({ error: 'Contraseña no válida' });

        const updatedPayload = {
            ...existing,
            article: req.body?.articleJSON || existing.article,
            updatedAt: new Date().toISOString(),
            version: (existing.version || 1) + 1
        };

        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
            Body: JSON.stringify(updatedPayload, null, 2),
            ContentType: 'application/json'
        }));

        res.json({ message: 'Artículo actualizado correctamente' });
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
            return res.status(404).json({ error: `Artículo con ID ${req.params.id} no encontrado` });
        }
        console.error(err);
        res.status(500).json({ error: 'Error actualizando el artículo en S3' });
    }
});



// DELETE: Eliminar un artículo
app.delete('/articles/:id', async (req, res) => {
    const fileKey = `${req.params.id}.json`;
    const rawPassword = req.body?.password;

    if (rawPassword === undefined || rawPassword === null) {
        return res.status(400).json({ error: 'Se requiere contraseña' });
    }

    const password = String(rawPassword);

    try {
        const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: fileKey }));
        const existing = JSON.parse(await Body.transformToString());

        if (!existing.passwordHash || typeof existing.passwordHash !== 'string') {
            return res.status(409).json({ error: 'El artículo fue creado sin contraseña. Por favor, migrelo primero.' });
        }

        const ok = await bcrypt.compare(password, existing.passwordHash);
        if (!ok) return res.status(403).json({ error: 'Contraseña no válida' });
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
            return res.status(404).json({ error: `Artículo con ID ${req.params.id} no encontrado` });
        }
        console.error(err);
        return res.status(500).json({ error: 'Error comprobando el artículo en S3' });
    }

    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileKey }));
        res.json({ message: 'Artículo eliminado correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error eliminando el artículo de S3' });
    }
});

//---------------- CATEGORIES
app.post('/categories', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: 'Se requiere id y nombre' });
    }

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: `categories/${id}.json`,
            Body: JSON.stringify({ id, name }, null, 2),
            ContentType: 'application/json'
        }));
        res.status(201).json({ message: 'Categoría creada correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error creando la categoría en S3' });
    }
});
app.get('/categories', async (req, res) => {
    try {
        const data = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucketName, Prefix: 'categories/' })
        );

        const categories = (data.Contents || []).map((obj) => {
            const keyParts = obj.Key.split('/');
            const id = keyParts[1]?.replace('.json', '');
            return { id, ...JSON.parse(obj.Body) };
        });

        res.json(categories);
    } catch (err) {
        console.error('Error listando categorías:', err);
        res.status(500).json({ error: 'Error al listar categorías' });
    }
});

//---------------- CARDS

function isCardKey(key = '') {
    return key.toLowerCase().endsWith('.svg') || key.toLowerCase().endsWith('.png');
}

// POST: Subir SVGs de cartas bajo un título (nombre del mazo)
app.get('/cards', async (req, res) => {
    try {
        const data = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucketName })
        );

        if (!data.Contents) return res.json([]);

        const cardKeys = data.Contents
            .filter((obj) => isCardKey(obj.Key))
            .map((obj) => obj.Key);

        const decksMap = {};

        await Promise.all(
            cardKeys.map(async (key) => {
                const [title, file] = key.split('/');
                if (!title || !file) return;

                const name = file.replace(/\.svg$/i, '');

                const unsignedUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

                (decksMap[title] ||= []).push({ name, url: unsignedUrl });
            })
        );

        const decks = Object.entries(decksMap).map(([title, cards]) => ({
            title,
            cards,
        }));

        res.json(decks);
    } catch (err) {
        console.error('Error listando cartas:', err);
        res.status(500).json({ error: 'Error al listar cartas' });
    }
});

app.get('/cards/:title', async (req, res) => {
    const prefix = `${req.params.title}/`;

    try {
        const data = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix })
        );

        const files = (data.Contents || [])
            .filter((obj) => isCardKey(obj.Key))
            .map((obj) => obj.Key);
        res.json({ files });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al listar cartas' });
    }
});

// DELETE: Cards
async function listCardKeys(prefix = '') {
    let ContinuationToken;
    const keys = [];

    do {
        const { Contents, IsTruncated, NextContinuationToken } =
            await s3Client.send(
                new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: prefix,
                    ContinuationToken,
                })
            );

        (Contents || [])
            .filter((obj) => isCardKey(obj.Key))
            .forEach((obj) => keys.push(obj.Key));

        ContinuationToken = IsTruncated ? NextContinuationToken : undefined;
    } while (ContinuationToken);

    return keys;
}

/** Borra un array de claves S3 (en lotes de 1000 máx.) */
async function deleteKeys(keys = []) {
    const chunked = [];
    for (let i = 0; i < keys.length; i += 1000) {
        chunked.push(keys.slice(i, i + 1000));
    }

    await Promise.all(
        chunked.map((batch) =>
            s3Client.send(
                new DeleteObjectsCommand({
                    Bucket: bucketName,
                    Delete: {
                        Objects: batch.map((Key) => ({ Key })),
                        Quiet: true,
                    },
                })
            )
        )
    );
    return keys.length;
}

/* Borra TODAS las cartas (svg) de un mazo concreto */
app.delete('/cards/:title', async (req, res) => {
    const { title } = req.params;
    const prefix = `${title}/`; // carpeta

    try {
        const keys = await listCardKeys(prefix);
        if (keys.length === 0) {
            return res
                .status(404)
                .json({ error: `No se encontraron cartas para el mazo "${title}"` });
        }

        const deleted = await deleteKeys(keys);
        res.json({
            message: `Mazo "${title}" eliminado (${deleted} cartas)`,
        });
    } catch (err) {
        console.error('Error deleting deck:', err);
        res.status(500).json({ error: 'Error eliminando el mazo' });
    }
});

/* Borra TODAS las cartas de TODOS los mazos */
app.delete('/cards', async (_req, res) => {
    try {
        const keys = await listCardKeys();
        if (keys.length === 0) {
            return res.status(404).json({ error: 'No hay cartas para eliminar' });
        }

        const deleted = await deleteKeys(keys);
        res.json({ message: `Eliminadas ${deleted} cartas en total` });
    } catch (err) {
        console.error('Error deleting all decks:', err);
        res.status(500).json({ error: 'Error eliminando todas las cartas' });
    }
});

app.post('/cards', async (req, res) => {
    const { title, cards } = req.body;

    if (!title || !Array.isArray(cards)) {
        return res.status(400).json({ error: 'Se requiere un título y un array de cartas' });
    }

    try {
        await Promise.all(
            cards.map(async (card, idx) => {
                const { name, svgBase64, pngBase64 } = card;

                // base64 de la imagen (uno u otro campo)
                const base64 = svgBase64 || pngBase64;
                if (!name || !base64) {
                    throw new Error(`Falta nombre o imagen en el índice ${idx}`);
                }

                /* Determinamos extensión y MIME */
                const isPng = !!pngBase64;
                const ext = isPng ? 'png' : 'svg';
                const type = isPng ? 'image/png' : 'image/svg+xml';

                const key = `${title}/${name}.${ext}`;

                await s3Client.send(
                    new PutObjectCommand({
                        Bucket: bucketName,
                        Key: key,
                        Body: Buffer.from(base64, 'base64'),
                        ContentType: type,
                    })
                );
            })
        );

        res.status(201).json({ message: `Cartas subidas a /${title}/` });
    } catch (err) {
        console.error('Error al subir cartas:', err);
        res.status(500).json({ error: 'Error al subir las cartas' });
    }
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
