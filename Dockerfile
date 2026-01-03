# Lightweight Node.js image for fast startup
FROM apify/actor-node:22-slim

# Copy package files first for caching
COPY package.json ./

# Install dependencies (minimal - only apify + got-scraping)
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy source code
COPY . ./

# Run the actor
CMD ["npm", "start"]
