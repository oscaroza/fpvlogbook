import express from 'express';
import cors from 'cors';
import sgMail from '@sendgrid/mail';
import admin from 'firebase-admin';

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY; // shared secret pour protéger l’endpoint
const SENDGRID_KEY = process.env.SENDGRID_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM;
const FIREBASE_JSON = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON complet de compte de service

if (!SENDGRID_KEY || !SENDGRID_FROM || !FIREBASE_JSON) {
  throw new Error('Config manquante: SENDGRID_KEY, SENDGRID_FROM, FIREBASE_SERVICE_ACCOUNT');
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_JSON)) });
}
sgMail.setApiKey(SENDGRID_KEY);
const db = admin.firestore();

const DEFAULT_PREFS = { notifyMeetingCreated: true, notifyMeetingInvolvingMe: true, notifyNewFlight: false };
const prefs = (u) => ({ ...DEFAULT_PREFS, ...(u.notificationPrefs || {}) });

async function sendMail(to, subject, text) {
  if (!to.length) return;
  await sgMail.send({ to, from: SENDGRID_FROM, subject, text }, false);
}

app.post('/notify', async (req, res) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).send('unauthorized');
  const { type, id } = req.body || {};
  if (!type || !id) return res.status(400).send('missing type/id');

  const col = type === 'meeting' ? 'meetings' : 'flights';
  const snap = await db.collection(col).doc(id).get();
  if (!snap.exists) return res.status(404).send('not found');
  const payload = snap.data();

  const users = (await db.collection('users').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  let recipients = [];
  if (type === 'meeting') {
    recipients = users.filter(u => u.email).filter(u => {
      const p = prefs(u);
      const involves = payload.host === u.username || payload.coPilot === u.username;
      return p.notifyMeetingCreated || (involves && p.notifyMeetingInvolvingMe);
    }).map(u => u.email);
    await sendMail(
      recipients,
      `Nouveau rendez-vous: ${payload.locationName || 'FPV'}`,
      `Date: ${payload.date}\nLieu: ${payload.locationName || payload.address || ''}\nNotes: ${payload.notes || ''}`
    );
  } else {
    recipients = users.filter(u => u.email).filter(u => {
      const p = prefs(u);
      const involves = payload.pilot === u.username || payload.coPilot === u.username;
      return p.notifyNewFlight || involves;
    }).map(u => u.email);
    await sendMail(
      recipients,
      `Nouveau vol: ${payload.spot || 'FPV'}`,
      `Spot: ${payload.spot || ''}\nPilote: ${payload.pilot || ''}\nCo-pilote: ${payload.coPilot || ''}\nNotes: ${payload.notes || ''}`
    );
  }
  res.send({ sent: recipients.length });
});

app.get('/', (_, res) => res.send('ok'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Mailer running on ${port}`));
