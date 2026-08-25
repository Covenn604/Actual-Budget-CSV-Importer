FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data/profiles
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm","start"]
