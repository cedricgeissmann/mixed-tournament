FROM node:20-alpine

# Install build tools needed for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
