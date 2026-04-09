FROM node:20-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libxshmfence1 \
    fonts-noto \
    fonts-noto-cjk \
    fonts-liberation \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libglib2.0-0 \
    libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

# Install all 3 browser engines
RUN npx playwright install chromium webkit firefox

COPY server.js ./

EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]
