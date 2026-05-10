// ============================================================
//  AKOUA STUDIO — Webhook Mollie → Supabase
//  Fichier : api/mollie-webhook.js
//  À placer dans GitHub : priscaakoua00-sys/akoua-studio-webhook
//  Dossier : api/mollie-webhook.js
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// Variables d'environnement (à configurer dans Vercel)
const SUPA_URL = process.env.SUPA_URL || 'https://cbvbvyudwstcbkhjcqav.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNidmJ2eXVkd3N0Y2JraGpjcWF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NTczNjksImV4cCI6MjA5MzIzMzM2OX0.jVfyvEgcmT8ettrjl65eyS1P-WPSGHc1tPanH6jlFOA';
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY; // Ta clé API Mollie (live_...)

const supa = createClient(SUPA_URL, SUPA_KEY);

// Correspondance montant → formule
function getFormule(amount) {
  const montant = parseFloat(amount);
  if (montant === 20)  return { formula: 'Express',      hours: 0.25 };
  if (montant === 35)  return { formula: 'Quick',        hours: 0.5  };
  if (montant === 60)  return { formula: 'Essential',    hours: 1    };
  if (montant === 125) return { formula: 'Signature',    hours: 3    }; // offre juin
  if (montant === 150) return { formula: 'Signature',    hours: 3    };
  if (montant === 299) return { formula: 'Full Day',     hours: 8    };
  if (montant === 199) return { formula: 'Starter Abo',  hours: 8    };
  if (montant === 399) return { formula: 'Pro Abo',      hours: 20   };
  if (montant === 699) return { formula: 'Unlimited Abo',hours: 0    };
  return { formula: `Session €${montant}`, hours: 0 };
}

// Calcul BTW 21%
function calcBTW(ttc) {
  const ht  = Math.round((ttc / 1.21) * 100) / 100;
  const btw = Math.round((ttc - ht) * 100) / 100;
  return { ht, btw };
}

// Récupérer les détails du paiement depuis Mollie
async function getMolliePayment(paymentId) {
  if (!MOLLIE_API_KEY) return null;
  try {
    const res = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Mollie fetch error:', e);
    return null;
  }
}

// Handler principal
module.exports = async function handler(req, res) {
  // Mollie envoie POST avec le paymentId dans le body
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Lire le body (Vercel parse automatiquement)
    const body = req.body || {};
    const paymentId = body.id;

    if (!paymentId) {
      console.log('Webhook reçu sans paymentId');
      return res.status(200).json({ received: true });
    }

    console.log('Webhook Mollie reçu — paymentId:', paymentId);

    // Récupérer les détails du paiement depuis Mollie
    const payment = await getMolliePayment(paymentId);

    if (!payment || payment.status !== 'paid') {
      console.log('Paiement non confirmé ou erreur:', payment?.status);
      return res.status(200).json({ received: true, status: payment?.status });
    }

    // Extraire les informations
    const montant    = parseFloat(payment.amount?.value || 0);
    const description = payment.description || '';
    const { formula, hours } = getFormule(montant);
    const { ht, btw } = calcBTW(montant);

    // Nom du client depuis metadata Mollie (si disponible)
    const metadata = payment.metadata || {};
    const clientName  = metadata.name  || payment.billingAddress?.familyName || 'Client';
    const clientEmail = metadata.email || payment.billingAddress?.email || '';
    const clientPhone = metadata.phone || '';
    const sessionDate = metadata.date  || new Date().toISOString().split('T')[0];
    const sessionTime = metadata.time  || '';

    // Créer l'ID unique
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Enregistrer dans Supabase — table "sessies"
    const sessionData = {
      id:           uid,
      name:         clientName,
      email:        clientEmail,
      phone:        clientPhone,
      session_date: sessionDate,
      session_time: sessionTime,
      date:         sessionDate,
      formula:      formula,
      price:        montant,
      hours:        hours,
      ht:           ht,
      tva:          btw,
      status:       'confirmed',
      notes:        `Mollie ID: ${paymentId} — ${description}`,
      mollie_id:    paymentId,
      created_at:   new Date().toISOString(),
    };

    const { error: sessionError } = await supa
      .from('sessies')
      .upsert([sessionData], { onConflict: 'id' });

    if (sessionError) {
      console.error('Erreur Supabase sessies:', sessionError);
    } else {
      console.log('✅ Session enregistrée dans Supabase:', formula, '€'+montant);
    }

    // Enregistrer aussi dans "boekingen" pour visibilité admin
    const bookingData = {
      id:           'bk_' + uid,
      name:         clientName,
      email:        clientEmail,
      phone:        clientPhone,
      booking_date: sessionDate,
      date:         sessionDate,
      formula:      formula,
      status:       'confirmed',
      message:      `Paiement automatique Mollie — ${paymentId} — €${montant}`,
      created_at:   new Date().toISOString(),
    };

    const { error: bookingError } = await supa
      .from('boekingen')
      .upsert([bookingData], { onConflict: 'id' });

    if (bookingError) {
      console.error('Erreur Supabase boekingen:', bookingError);
    }

    // Réponse 200 obligatoire pour Mollie
    return res.status(200).json({
      received: true,
      payment_id: paymentId,
      formula: formula,
      amount: montant,
      client: clientName,
    });

  } catch (err) {
    console.error('Webhook error:', err);
    // Toujours 200 pour Mollie (sinon il réessaie en boucle)
    return res.status(200).json({ received: true, error: err.message });
  }
};
