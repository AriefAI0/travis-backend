# Standalone report renderer. Build from the repo root:
#   docker build -t travis-report-generator report-generator-service
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

# MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY and BUCKET_MEDIA come from
# the environment at run time. Credentials are never baked into the image.
EXPOSE 3100

CMD ["node", "index.js"]
