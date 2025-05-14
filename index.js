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
const ORDERS_COLLECTION = 'orders';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) {
    console.log("connectToDatabase: Returning cached database connection");
    return cachedDb;
  }
  try {
    console.log("connectToDatabase: Connecting to MongoDB...");
    const client = await MongoClient.connect(MONGODB_URI);
    cachedDb = client.db(DB_NAME);
    console.log('connectToDatabase: Successfully connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('connectToDatabase: Error connecting to MongoDB:', error);
    throw error;
  }
};

async function sendMessage(to, message, isInteractive = false, buttons = []) {
  try {
    console.log(`sendMessage: called with to: ${to}, message: ${message}, isInteractive: ${isInteractive}`);
    
    const messagePayload = isInteractive ? {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: buttons.map((btn, index) => ({
            type: 'reply',
            reply: {
              id: `btn_${index}_${btn.id || index}`,
              title: btn.title
            }
          }))
        }
      }
    } : {
      messaging_product: 'whatsapp',
      to,
      text: { body: message },
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('sendMessage: successful');
  } catch (err) {
    console.error('sendMessage: Error sending message:', err.response?.data || err.message);
    throw err;
  }
}

async function sendListMessage(to, headerText, bodyText, buttonText, sections) {
  try {
    console.log(`sendListMessage: called with to: ${to}`);
    
    const messagePayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: headerText
        },
        body: {
          text: bodyText
        },
        action: {
          button: buttonText,
          sections
        }
      }
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('sendListMessage: successful');
  } catch (err) {
    console.error('sendListMessage: Error sending message:', err.response?.data || err.message);
    throw err;
  }
}

// NEW FUNCTION: Send location request with one-tap button
async function requestLocation(to) {
  try {
    console.log(`requestLocation: called with to: ${to}`);
    
    const messagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: {
          text: '📍 Please share your location to continue with your order'
        },
        action: {
          name: 'send_location',
          button: 'Share My Location'
        }
      }
    };

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      messagePayload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('requestLocation: successful');
  } catch (err) {
    console.error('requestLocation: Error sending location request:', err.response?.data || err.message);
    // Fallback to regular text instructions
    await sendMessage(to, "📍 Please share your location to continue. Tap the 📎 attachment icon and select 'Location'.");
  }
}

app.get('/webhook', (req, res) => {
  console.log("GET /webhook: Received webhook verification request");
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`GET /webhook: mode: ${mode}, token: ${token}, challenge: ${challenge}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('GET /webhook: Webhook verification successful');
    res.status(200).send(challenge);
  } else {
    console.log('GET /webhook: Webhook verification failed');
    res.sendStatus(403);
  }
});

const userState = {};

app.post('/webhook', async (req, res) => {
  console.log("POST /webhook: Received webhook event");
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const location = message?.location;
  const buttonResponse = message?.interactive?.button_reply;
  const listResponse = message?.interactive?.list_reply;

  if (!message && !buttonResponse && !listResponse) {
    console.log("POST /webhook: No message or interactive response found in payload");
    return res.sendStatus(200);
  }

  const from = message?.from || buttonResponse?.from || listResponse?.from;
  const msgBody = message?.text?.body?.trim().toLowerCase() || '';
  const buttonId = buttonResponse?.id;
  const buttonTitle = buttonResponse?.title?.toLowerCase() || '';
  const listId = listResponse?.id;
  const listTitle = listResponse?.title?.toLowerCase() || '';
  
  console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonId: ${buttonId}, buttonTitle: ${buttonTitle}, listId: ${listId}, listTitle: ${listTitle}, location: ${JSON.stringify(location)}`);
  
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);
  const ordersCollection = db.collection(ORDERS_COLLECTION);

  if (!userState[from]) {
    userState[from] = { stage: 'start' };
  }

  const state = userState[from];
  console.log(`POST /webhook: User state for ${from}:`, state);

  // Handle interactive responses first
  if (buttonResponse || listResponse) {
    const responseId = buttonId || listId;
    const responseTitle = buttonTitle || listTitle;
    
    console.log(`Interactive response: ${responseTitle} (${responseId}) from ${from}`);
    
    if (state.stage === 'menu') {
      if (responseTitle.includes('place an order') || responseId.includes('place_order')) {
        await handlePlaceOrder(from, state, usersCollection);
        return res.sendStatus(200);
      } else if (responseTitle.includes('track your order') || responseId.includes('track_order')) {
        await handleTrackOrder(from, state, ordersCollection);
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'choose_address') {
      if (responseId.includes('address_')) {
        const index = parseInt(responseId.split('_')[1]);
        if (!isNaN(index) && state.addresses && index >= 0 && index < state.addresses.length) {
          const selectedAddress = state.addresses[index].address;
          state.stage = 'done';
          console.log(`Selected address: ${selectedAddress} for ${from}`);
          await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
          await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
          return res.sendStatus(200);
        }
      } else if (responseId.includes('new_address')) {
        state.stage = 'collect_location';
        await requestLocation(from); // Updated to use new location request
        return res.sendStatus(200);
      }
    }
    
    if (state.stage === 'track_order' && responseId.includes('order_')) {
      const index = parseInt(responseId.split('_')[1]);
      if (!isNaN(index) && state.orders && index >= 0 && index < state.orders.length) {
        const selectedOrder = state.orders[index];
        await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
        state.stage = 'done';
        delete userState[from];
        await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        return res.sendStatus(200);
      }
    }
  }

  // Handle text messages (fallback)
  if (msgBody === 'hello' || msgBody === 'hi' || state.stage === 'start') {
    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (!existingUser) {
      state.stage = 'collect_location';
      await requestLocation(from); // Updated to use new location request
    } else {
      state.stage = 'menu';
      await sendMessage(
        from, 
        '👋 Welcome back to Daal Mail!\n\nPlease choose an option:', 
        true, 
        [
          { title: 'Place an order', id: 'place_order' },
          { title: 'Track your order', id: 'track_order' }
        ]
      );
    }
    return res.sendStatus(200);
  } else if (state.stage === 'start') {
    await sendMessage(from, "Please send 'hi' or 'hello' to start.");
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_location') {
    if (location) {
      state.userLocation = location;
      state.stage = 'collect_address';
      await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
      console.log(`Location received: ${JSON.stringify(location)}`);
    } else {
      await requestLocation(from); // Resend the location request if invalid
    }
    return res.sendStatus(200);
  }

  // ... [rest of your existing code remains the same] ...

  res.sendStatus(200);
});

// Helper functions (handlePlaceOrder, handleTrackOrder, etc.) remain the same
// ... [include all your existing helper functions here] ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));