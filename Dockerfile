# Usa la imagen oficial de Node
FROM node:20

# Crea directorio de trabajo
WORKDIR /app

# Copia package.json y package-lock.json primero
COPY package*.json ./

# Instala dependencias
RUN npm install --omit=dev

# Copia el resto del código
COPY . .

# Exponer puerto 3000
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]
