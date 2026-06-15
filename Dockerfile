FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# Cloud Run injects PORT; the server reads it.
CMD ["npm", "start"]
