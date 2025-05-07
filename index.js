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
  console.log('Connected to MongoDB');
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verify_token) {
      console.log('Webhook verified!');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// Webhook for receiving messages
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const phone_number_id = changes.value.metadata.phone_number_id;
      const from = message.from;
      const text = message.text?.body;

      // Echo back the same message
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
    }

    return res.sendStatus(200);
  }

  res.sendStatus(404);
});

// Health check
app.get('/', (req, res) => {
  res.send('DaalMail WhatsApp Cloud API Bot is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
