# Use official Apify Node.js base image for guaranteed compatibility
FROM apify/actor-node:22

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy source code
COPY . ./

# Set environment
ENV APIFY_LOG_LEVEL=INFO

# Run the actor
CMD ["npm", "start", "--silent"]
