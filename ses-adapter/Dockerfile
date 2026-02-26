FROM node:18-alpine

WORKDIR /app

# Clone the repo and install deps
RUN apk add --no-cache git && \
    git clone https://github.com/exlab-code/ghost-cms-amazon-ses-adapter.git . && \
    npm install --omit=dev

# config.json will be mounted or copied at runtime
# (we don't bake secrets into the image)

EXPOSE 3001

CMD ["node", "ghost-ses-adapter.js"]