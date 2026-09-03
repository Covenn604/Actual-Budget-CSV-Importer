FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY import-reconciliation.js ./
COPY public ./public
RUN mkdir -p /app/data/profiles /tmp/actual-budget-csv-importer
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm","start"]
