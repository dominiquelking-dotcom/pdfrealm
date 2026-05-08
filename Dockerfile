FROM node:20-alpine
RUN apk add --no-cache ghostscript poppler-utils qpdf

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:assets

EXPOSE 9000
CMD ["node", "server.js"]
