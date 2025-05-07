const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'daalMail';
mongoose.connect(MONGODB_URI, {
  dbName: DB_NAME,
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
mongoose.connection.once('open', () => {
  console.log('✅ Connected to MongoDB');
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verified!');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// Webhook to handle incoming messages
app.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('📩 Incoming Webhook Payload:');
  console.log(JSON.stringify(body, null, 2));

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const phone_number_id = value.metadata.phone_number_id;
      const from = message.from;
      const messageType = message.type;

      try {
        if (messageType === 'text') {
          const text = message.text?.body;
          console.log(`👤 User: ${from} said: ${text}`);

          // Echo the message back
          await axios.post(
            `https://graph.facebook.com/v19.0/${phone_number_id}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: `You said: ${text}` },
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        } else {
          // Non-text message fallback
          console.log(`⚠️ Received unsupported message type: ${messageType}`);

          await axios.post(
            `https://graph.facebook.com/v19.0/${phone_number_id}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: 'Sorry, I can only understand text messages for now.' },
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        }
      } catch (error) {
        console.error('❌ Error sending response:', error.response?.data || error.message);
      }
    }

    return res.sendStatus(200);
  }

  res.sendStatus(404);
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ DaalMail WhatsApp Cloud API Bot is running');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
