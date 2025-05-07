// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
};

async function sendMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

const userState = {};

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const msgBody = message.text?.body?.trim().toLowerCase() || '';
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);

  if (!userState[from]) {
    userState[from] = { stage: 'start' };
  }

  const state = userState[from];

  if (msgBody === 'hello' || state.stage === 'start') {
    state.stage = 'menu';
    await sendMessage(from, '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order');
    return res.sendStatus(200);
  }

  if (msgBody === '1' && state.stage === 'menu') {
    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
      state.stage = 'collect_address';
      await sendMessage(from, '📍 Please share your address to proceed with your order.');
    } else {
      const prevAddr = existingUser.previousAddresses[0].address;
      await sendMessage(from, `📦 We found your previous address:\n${prevAddr}\n\nTo continue ordering, visit: ${NETLIFY_MENU_LINK}`);
      state.stage = 'done';
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
    const newUserData = {
      waNumber: from,
      previousAddresses: [
        {
          address,
          location: null, // You can collect and update location separately later
        },
      ],
    };
    await usersCollection.insertOne(newUserData);
    state.stage = 'done';
    await sendMessage(from, `✅ Address saved!\n\nNow you can order from our menu here: ${NETLIFY_MENU_LINK}`);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
