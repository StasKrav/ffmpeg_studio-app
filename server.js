import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка директорий
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

await fs.ensureDir(UPLOAD_DIR);
await fs.ensureDir(OUTPUT_DIR);

// Очистка старых файлов каждые 30 минут
setInterval(async () => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000;
    
    for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
        try {
            const files = await fs.readdir(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    await fs.remove(filePath).catch(() => {});
                }
            }
        } catch (err) {}
    }
}, 30 * 60 * 1000);

// Middleware для правильной кодировки
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
    }
}));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/outputs', express.static(OUTPUT_DIR));

// Настройка multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }
});

// Загрузка файлов
app.post('/api/upload', upload.array('files'), (req, res) => {
    try {
        const files = req.files.map(file => ({
            id: path.basename(file.filename, path.extname(file.filename)),
            originalName: file.originalname,
            filename: file.filename,
            size: file.size,
            url: `/uploads/${file.filename}`
        }));
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Обработка команд
app.post('/api/process', async (req, res) => {
    const { operation, params, files } = req.body;
    
    console.log('Получен запрос:', { operation, params });
    
    try {
        const findFileById = (fileId) => {
            if (!fileId) return null;
            const file = files.find(f => f.id === fileId);
            if (!file) return null;
            const filePath = path.join(UPLOAD_DIR, file.filename);
            if (!fs.existsSync(filePath)) return null;
            return file;
        };
        
        const outputFilename = `${uuidv4()}.${params.format || 'mp4'}`;
        const outputPath = path.join(OUTPUT_DIR, outputFilename);
        
        let command = null;
        
        switch (operation) {
            case 'photo-music': {
                const imageFile = findFileById(params.param1);
                const audioFile = findFileById(params.param2);
                if (!imageFile) throw new Error('Изображение не найдено');
                if (!audioFile) throw new Error('Аудио не найдено');
                
                command = ffmpeg()
                    .input(path.join(UPLOAD_DIR, imageFile.filename))
                    .inputOptions(['-loop 1'])
                    .input(path.join(UPLOAD_DIR, audioFile.filename))
                    .outputOptions([
                        '-c:v libx264',
                        `-crf ${params.quality || 23}`,
                        '-preset medium',
                        '-c:a aac',
                        '-b:a 192k',
                        '-shortest',
                        '-pix_fmt yuv420p'
                    ])
                    .output(outputPath);
                break;
            }
            
            case 'convert': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error('Файл не найден');
                
                command = ffmpeg(path.join(UPLOAD_DIR, inputFile.filename))
                    .outputOptions(['-c:v libx264', '-c:a aac'])
                    .output(outputPath);
                break;
            }
            
            case 'extract': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error('Файл не найден');
                
                const audioCodec = params.format === 'mp3' ? 'libmp3lame' : params.format;
                command = ffmpeg(path.join(UPLOAD_DIR, inputFile.filename))
                    .outputOptions(['-vn', `-acodec ${audioCodec}`, '-q:a 2'])
                    .output(outputPath);
                break;
            }
            
            case 'compress': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error('Файл не найден');
                
                command = ffmpeg(path.join(UPLOAD_DIR, inputFile.filename))
                    .outputOptions(['-c:v libx264', `-crf ${params.quality || 23}`, '-c:a aac', '-b:a 128k'])
                    .output(outputPath);
                break;
            }
            
            case 'trim': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error('Файл не найден');
                
                command = ffmpeg(path.join(UPLOAD_DIR, inputFile.filename))
                    .setStartTime(parseFloat(params.start) || 0)
                    .duration(parseFloat(params.duration) || 10)
                    .outputOptions(['-c copy'])
                    .output(outputPath);
                break;
            }
            
            case 'thumbnail': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error('Файл не найден');
                
                command = ffmpeg(path.join(UPLOAD_DIR, inputFile.filename))
                    .seekInput(parseFloat(params.time) || 5)
                    .frames(1)
                    .outputOptions([`-vf scale=${params.size || '640x480'}`])
                    .output(outputPath);
                break;
            }
            
            case 'merge': {
                const file1 = findFileById(params.param1);
                const file2 = findFileById(params.param2);
                if (!file1) throw new Error('Файл 1 не найден');
                if (!file2) throw new Error('Файл 2 не найден');
                
                const listPath = path.join(UPLOAD_DIR, `list_${uuidv4()}.txt`);
                await fs.writeFile(listPath, `file '${path.join(UPLOAD_DIR, file1.filename)}'\nfile '${path.join(UPLOAD_DIR, file2.filename)}'`, 'utf8');
                
                command = ffmpeg()
                    .input(listPath)
                    .inputOptions(['-f concat', '-safe 0'])
                    .outputOptions(['-c copy'])
                    .output(outputPath)
                    .on('end', () => fs.remove(listPath).catch(() => {}));
                break;
            }
            
            case 'speed': {
                const inputFile = findFileById(params.param1);
                if (!inputFile) throw new Error(`Файл не найден: ${params.param1}`);
                
                const inputPath = path.join(UPLOAD_DIR, inputFile.filename);
                let speed = parseFloat(params.speedFactor) || 1.0;
                const speedType = params.speedType || 'video';
                
                console.log(`Изменение скорости: ${speed}x, тип: ${speedType}`);
                
                if (Math.abs(speed - 1.0) < 0.001) {
                    command = ffmpeg(inputPath)
                        .outputOptions(['-c copy'])
                        .output(outputPath);
                } else {
                    const buildAtempoChain = (factor) => {
                        if (factor >= 0.5 && factor <= 2.0) {
                            return `atempo=${factor.toFixed(6)}`;
                        }
                        const parts = [];
                        let remaining = factor;
                        while (remaining > 2.0) {
                            parts.push('atempo=2.0');
                            remaining = remaining / 2;
                        }
                        while (remaining < 0.5) {
                            parts.push('atempo=0.5');
                            remaining = remaining / 0.5;
                        }
                        if (Math.abs(remaining - 1.0) > 0.001) {
                            parts.push(`atempo=${remaining.toFixed(6)}`);
                        }
                        return parts.join(',');
                    };
                    
                    const videoFilter = (speedType === 'video' || speedType === 'video-only') 
                        ? `setpts=${(1/speed).toFixed(6)}*PTS` 
                        : null;
                    
                    const audioFilter = (speedType === 'video' || speedType === 'audio-only') 
                        ? buildAtempoChain(speed) 
                        : null;
                    
                    const ff = ffmpeg(inputPath);
                    
                    if (videoFilter && audioFilter) {
                        ff.videoFilters(videoFilter);
                        ff.audioFilters(audioFilter);
                        ff.outputOptions(['-c:v libx264', '-c:a aac']);
                    } else if (videoFilter) {
                        ff.videoFilters(videoFilter);
                        ff.outputOptions(['-c:v libx264', '-c:a copy']);
                    } else if (audioFilter) {
                        ff.audioFilters(audioFilter);
                        ff.outputOptions(['-c:v copy', '-c:a aac']);
                    } else {
                        ff.outputOptions(['-c copy']);
                    }
                    
                    command = ff.output(outputPath);
                }
                break;
            }
            
            default:
                throw new Error(`Неизвестная операция: ${operation}`);
        }
        
        if (command) {
            await new Promise((resolve, reject) => {
                command
                    .on('end', () => {
                        console.log('FFmpeg завершил работу');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('FFmpeg ошибка:', err);
                        reject(err);
                    })
                    .run();
            });
            
            const stats = await fs.stat(outputPath);
            
            res.json({
                success: true,
                outputFile: {
                    filename: outputFilename,
                    path: `/outputs/${outputFilename}`,
                    size: stats.size,
                    url: `/outputs/${outputFilename}`
                }
            });
        }
        
    } catch (error) {
        console.error('Ошибка обработки:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download/:filename', (req, res) => {
    const filePath = path.join(OUTPUT_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'Файл не найден' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Главный маршрут для index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), {
        headers: {
            'Content-Type': 'text/html; charset=utf-8'
        }
    });
});

app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   FFmpeg Studio Server                ║
    ║   http://localhost:${PORT}               ║
    ║   Готов к работе                       ║
    ╚═══════════════════════════════════════╝
    `);
});
