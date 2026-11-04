# Official Node.js 24 LTS slim image, pinned to an explicit patch version.
# Bump deliberately when a Node.js security release is published:
# https://nodejs.org/en/blog/vulnerability
FROM node:24.22.2-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running the install on every code change.
COPY package*.json ./

# Install production dependencies exactly as locked.
RUN npm ci --omit=dev

# Copy local code to the container image.
COPY . ./

# Run the web service on container startup.
CMD [ "npm", "start" ]
