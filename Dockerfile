FROM node:20-alpine
# deps para git y para compilar better-sqlite3
RUN apk add --no-cache git python3 make g++ sqlite-dev
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node","server.js"]
