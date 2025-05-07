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
const COLLECTION_NAME = 'orders';
const USERS_COLLECTION = 'users';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
};

const userState = {};
const defaultLocation = { latitude: 12.833365, longitude: 77.690315 };
const imageUrl = 'https://i.ibb.co/wnNL4s5/food-sample.jpg';
const menu = [
  { id: 1, name: 'Dal', price: 50, imageUrl },
  { id: 2, name: 'Chole', price: 60, imageUrl },
  { id: 3, name: 'Rajma', price: 55, imageUrl },
  { id: 4, name: 'Kadi', price: 45, imageUrl },
  { id: 5, name: 'Rice', price: 30, imageUrl },
  { id: 6, name: 'Bread', price: 20, imageUrl },
];

function getItemIdFromName(itemName) {
  const item = menu.find(i => i.name.toLowerCase() === itemName.toLowerCase());
  return item ? item.id : null;
}

async function sendMessage(to, message) {
  console.log(`📤 Sending message to ${to}: ${message}`);
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    text: { body: message },
  }, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
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

app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Incoming message:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgBody = message.text?.body?.trim() || '';
    const type = message.type;

    console.log(`👤 Message from ${from}: ${msgBody}`);

    const db = await connectToDatabase();
    const usersCollection = db.collection(USERS_COLLECTION);
    const ordersCollection = db.collection(COLLECTION_NAME);

    let user = userState[from] || {
      started: false,
      isOrdering: false,
      isTracking: false,
      expectingNextStep: null,
      menuShown: false,
      currentOrder: [],
      previousAddresses: [],
    };
    userState[from] = user;

    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (existingUser?.previousAddresses) user.previousAddresses = existingUser.previousAddresses;

    // Step 1: Greet and ask what user wants to do
    if (!user.started) {
      user.started = true;
      await sendMessage(from, '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order\n2. Track an order');
      return res.sendStatus(200);
    }

    // Step 2: Handle main menu choices
    if (msgBody === '1') {
      user.isOrdering = true;
      user.isTracking = false;

      if (user.previousAddresses.length > 0) {
        let addressList = user.previousAddresses.map((addr, i) => `${i + 1}. ${addr}`).join('\n');
        await sendMessage(from, `📍 We found your previous addresses:\n${addressList}\n${user.previousAddresses.length + 1}. Use a new address`);
        user.expectingNextStep = 'choose_address';
      } else {
        await sendMessage(from, '📍 Please share your location to place the order.');
        user.expectingNextStep = 'get_location';
      }
      return res.sendStatus(200);
    }

    if (user.expectingNextStep === 'choose_address') {
      const choice = parseInt(msgBody);
      if (choice >= 1 && choice <= user.previousAddresses.length) {
        user.address = user.previousAddresses[choice - 1];
        await sendMessage(from, '📋 Here is our menu:\n' + menu.map(item => `${item.id}. ${item.name} - ₹${item.price}`).join('\n'));
        user.expectingNextStep = 'order_items';
      } else if (choice === user.previousAddresses.length + 1) {
        await sendMessage(from, '📍 Please share your new location.');
        user.expectingNextStep = 'get_location';
      } else {
        await sendMessage(from, '❌ Invalid choice. Please select from the given options.');
      }
      return res.sendStatus(200);
    }

    if (user.expectingNextStep === 'get_location') {
      if (message.location) {
        const address = `Lat: ${message.location.latitude}, Lon: ${message.location.longitude}`;
        user.address = address;
        user.previousAddresses.push(address);
        await usersCollection.updateOne(
          { waNumber: from },
          { $set: { waNumber: from }, $addToSet: { previousAddresses: address } },
          { upsert: true }
        );
        await sendMessage(from, '✅ Location saved!\nHere is our menu:\n' + menu.map(item => `${item.id}. ${item.name} - ₹${item.price}`).join('\n'));
        user.expectingNextStep = 'order_items';
      } else {
        await sendMessage(from, '📍 Please share your location using WhatsApp location feature.');
      }
      return res.sendStatus(200);
    }

    if (user.expectingNextStep === 'order_items') {
      const itemId = parseInt(msgBody);
      const item = menu.find(i => i.id === itemId);
      if (item) {
        user.currentOrder.push(item);
        await sendMessage(from, `🛒 Added ${item.name} to your cart.\nType another item number to add more or type "done" to finish.`);
      } else if (msgBody.toLowerCase() === 'done') {
        if (user.currentOrder.length === 0) {
          await sendMessage(from, '❗ Your cart is empty. Please select at least one item.');
        } else {
          const total = user.currentOrder.reduce((sum, i) => sum + i.price, 0);
          await ordersCollection.insertOne({ waNumber: from, items: user.currentOrder, address: user.address, createdAt: new Date() });
          await sendMessage(from, `✅ Order placed!\nTotal: ₹${total}\nDelivery to: ${user.address}`);
          user.currentOrder = [];
          user.expectingNextStep = null;
        }
      } else {
        await sendMessage(from, '❌ Invalid input. Please type an item number or "done".');
      }
      return res.sendStatus(200);
    }

    await sendMessage(from, '❓ I didn\'t understand that. Please type "1" to place an order or "2" to track.');
    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error in webhook handler:', error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
