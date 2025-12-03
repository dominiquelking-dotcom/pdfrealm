# Small Node image
FROM node:20-alpine

# App directory
WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Env & port
ENV PORT=8080
EXPOSE 8080

# Start server
CMD ["node", "server.js"]
