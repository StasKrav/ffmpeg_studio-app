# Используем официальный Node.js образ
FROM node:20-slim

# Устанавливаем FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Создаём рабочую директорию
WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json ./
RUN npm install --production

# Копируем исходный код
COPY server.js ./
COPY public ./public

# Создаём директории для загрузок и результатов
RUN mkdir -p uploads outputs

# Тома для хранения файлов (не теряются при перезапуске)
VOLUME ["/app/uploads", "/app/outputs"]

# Порт приложения
EXPOSE 3000

# Проверка здоровья
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Запуск
CMD ["node", "server.js"]