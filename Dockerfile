FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]
