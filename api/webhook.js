module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'No payment ID' });

    // 1. Vérifier le paiement auprès de Mollie
    const mollieRes = await fetch(`https://api.mollie.com/v2/payments/${id}`, {
      headers: { 'Authorization': `Bearer ${process.env.MOLLIE_API_KEY}` }
    });
    const payment = await mollieRes.json();

    if (payment.status !== 'paid') {
      return res.status(200).json({ status: 'not_paid_yet' });
    }

    // 2. Extraire les infos
    const meta = payment.metadata || {};
    const session = {
      client: meta.naam || payment.description,
      formula: meta.formule || payment.description,
      price: parseFloat(payment.amount.value),
      date: new Date().toLocaleDateString('nl-NL'),
      paid: true,
      mollie_id: payment.id,
      created_at: new Date().toISOString(),
    };

    // 3. Sauvegarder dans Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(session),
      });
    }

    // 4. Notification WhatsApp
    if (process.env.WA_KEY) {
      const msg = encodeURIComponent(
        `🎉 Nieuw betaling!\nKlant: ${session.client}\nFormule: ${session.formula}\nBedrag: €${session.price}\n✅ Automatisch opgeslagen!`
      );
      await fetch(`https://api.callmebot.com/whatsapp.php?phone=31627374813&text=${msg}&apikey=${process.env.WA_KEY}`);
    }

    return res.status(200).json({ success: true, session });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
