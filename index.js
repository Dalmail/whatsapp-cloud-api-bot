const express = require('express');
const venom = require('venom-bot');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Initialize express app
const app = express();
app.use(express.json());

// MongoDB connection URI and database name
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'daalMail';
const COLLECTION_NAME = 'orders';
const USERS_COLLECTION = 'users';

// Initialize Venom-bot
venom
  .create({ session: 'cloud-kitchen-session', multidevice: true, headless: false })
  .then((client) => {
    console.log('WhatsApp bot is ready');
    start(client);
  })
  .catch((error) => {
    console.log('Error initializing bot:', error);
  });

// Connect to MongoDB
let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
};

// Express endpoint to check if the server is running
app.get('/', (req, res) => {
  res.send('Cloud Kitchen WhatsApp Bot is running');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle message interactions with the WhatsApp bot
function start(client) {
  // Your messageHandler.js code goes here to handle user interactions with the bot
  require('./messageHandler')(client);
}
