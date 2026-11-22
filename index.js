require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  Partials,
  REST,
  Routes,
} = require('discord.js');

// ───────────────────────── CONFIGURAZIONE ─────────────────────────
const {
  TOKEN,
  CLIENT_ID,
  GUILD_ID, // opzionale: se presente i comandi si registrano subito sul tuo server
  STAFF_ROLE_ID,
  CATEGORY_ID, // opzionale: categoria dove creare i ticket
  LOG_CHANNEL_ID, // opzionale: canale dove inviare le trascrizioni
  PANEL_GIF_URL, // opzionale: link diretto a una GIF/immagine da mostrare nel pannello
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({ TOKEN, CLIENT_ID, STAFF_ROLE_ID })) {
  if (!value) {
    console.error(`❌ Variabile d'ambiente mancante: ${name}`);
    process.exit(1);
  }
}

// ➜ INCOLLA QUI IL LINK DIRETTO DELLA TUA GIF (es. 'https://i.imgur.com/xxxxxxx.gif')
// Se lo lasci vuoto ('') il bot prova con il file zyra.gif o con la variabile PANEL_GIF_URL.
const PANEL_GIF_LINK = '';

// Nome del file GIF del pannello (alternativa al link: mettilo nella stessa cartella di index.js)
const PANEL_GIF_FILE = 'zyra.gif';

// Categorie di ticket (modificale come vuoi)
const CATEGORIES = {
  support: { label: 'Supporto', emoji: '🛠️', style: ButtonStyle.Primary },
  report: { label: 'Segnalazione', emoji: '🚨', style: ButtonStyle.Danger },
  partnership: { label: 'Partnership', emoji: '🤝', style: ButtonStyle.Success },
};

// ───────────────────────── WEB SERVER (per Render) ─────────────────────────
// Render richiede che un Web Service ascolti su una porta.
// Serve anche per il ping di UptimeRobot, che tiene sveglio il bot sul piano gratuito.
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot ticket online ✅');
  })
  .listen(PORT, () => console.log(`🌐 Web server in ascolto sulla porta ${PORT}`));

// ───────────────────────── AUTO-PING (keep-alive) ─────────────────────────
// Il bot visita il proprio indirizzo pubblico a intervalli regolari, così Render
// vede traffico e non mette il servizio in sleep (piano gratuito: sleep dopo ~15 min).
// RENDER_EXTERNAL_URL è impostata automaticamente da Render.
// Intervallo predefinito: 10 minuti (modificabile con PING_INTERVAL_MINUTES).
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
const PING_MINUTES = Number(process.env.PING_INTERVAL_MINUTES) || 10;

if (SELF_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(SELF_URL);
      console.log(`🏓 Auto-ping a ${SELF_URL}: ${res.status}`);
    } catch (err) {
      console.error('Auto-ping fallito:', err.message);
    }
  }, PING_MINUTES * 60 * 1000);
  console.log(`🏓 Auto-ping attivo ogni ${PING_MINUTES} minuti`);
} else {
  console.log('ℹ️ Auto-ping disattivato (nessun RENDER_EXTERNAL_URL: normale in locale)');
}

// ───────────────────────── CLIENT ─────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // necessario per le trascrizioni (attivalo nel Developer Portal)
    GatewayIntentBits.DirectMessages, // per chattare con Zyra in DM
  ],
  partials: [Partials.Channel], // obbligatorio per ricevere i DM
});

// ───────────────────────── COMANDI SLASH ─────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Invia il pannello dei ticket in questo canale')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Aggiungi un utente al ticket')
    .addUserOption((o) => o.setName('utente').setDescription("L'utente da aggiungere").setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Rimuovi un utente dal ticket')
    .addUserOption((o) => o.setName('utente').setDescription("L'utente da rimuovere").setRequired(true)),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`✅ Comandi slash registrati (${GUILD_ID ? 'server' : 'globali'})`);
}

client.once('ready', async () => {
  console.log(`🤖 Online come ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Errore nella registrazione dei comandi:', err);
  }
});

// ───────────────────────── FUNZIONI UTILI ─────────────────────────
const isStaff = (member) =>
  member.roles.cache.has(STAFF_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);

const isTicketChannel = (channel) => channel?.topic?.startsWith('ticket:');

// Il proprietario del ticket è salvato nel topic del canale: "ticket:<userId>:<categoria>"
// In questo modo il bot non ha bisogno di database (su Render il disco gratuito si azzera).
const getTicketOwnerId = (channel) => channel?.topic?.split(':')[1];

function findExistingTicket(guild, userId) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.topic?.startsWith(`ticket:${userId}:`)
  );
}

async function buildTranscript(channel) {
  const all = [];
  let lastId;
  while (all.length < 1000) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    all.push(...batch.values());
    lastId = batch.last().id;
  }
  all.reverse();

  const lines = all.map((m) => {
    const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    const text = m.content || (m.embeds.length ? '[embed]' : '');
    const files = m.attachments.size
      ? ` [Allegati: ${[...m.attachments.values()].map((a) => a.url).join(', ')}]`
      : '';
    return `[${time}] ${m.author.tag}: ${text}${files}`;
  });

  return `Trascrizione di #${channel.name}\nMessaggi: ${all.length}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
}

function ticketButtons(claimed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('claim_ticket')
      .setLabel(claimed ? 'Preso in carico' : 'Prendi in carico')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(claimed),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Chiudi ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ───────────────────────── GESTIONE INTERAZIONI ─────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isModalSubmit()) return await handleModal(interaction);
  } catch (err) {
    console.error('Errore interazione:', err);
    const msg = ephemeral('❌ Si è verificato un errore. Riprova più tardi.');
    if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// ───── Comandi slash ─────
async function handleCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'setup') {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Centro assistenza')
      .setDescription(
        'Benvenuto nel pannello di Zyra. ♡\n' +
          'Hai bisogno di aiuto? Non preoccuparti, ci sono io.\n' +
          'Apri un ticket e spiegami con calma il tuo problema: mi occuperò di indirizzarti verso lo staff più adatto.\n' +
          'Ricorda: sii educato, preciso e paziente. Il mio compito è assicurarmi che tu venga ascoltato.\n' +
          'Zyra si prende cura di tutto. ♡'
      )
      .setColor(0x2e0854); // viola molto scuro (striscia laterale del pannello)

    // GIF del pannello (piccola, in alto a destra): se nella cartella del bot c'è il file "zyra.gif" viene allegato
    // direttamente (nessun link necessario). Altrimenti si usa PANEL_GIF_URL, se impostata.
    // Ordine di priorità: 1) link scritto nel codice, 2) file zyra.gif, 3) variabile PANEL_GIF_URL.
    const files = [];
    const gifPath = path.join(__dirname, PANEL_GIF_FILE);
    if (PANEL_GIF_LINK) {
      embed.setThumbnail(PANEL_GIF_LINK);
    } else if (fs.existsSync(gifPath)) {
      files.push(new AttachmentBuilder(gifPath, { name: PANEL_GIF_FILE }));
      embed.setThumbnail(`attachment://${PANEL_GIF_FILE}`);
    } else if (PANEL_GIF_URL) {
      embed.setThumbnail(PANEL_GIF_URL);
    }

    const row = new ActionRowBuilder().addComponents(
      Object.entries(CATEGORIES).map(([key, cat]) =>
        new ButtonBuilder().setCustomId(`open:${key}`).setLabel(cat.label).setEmoji(cat.emoji).setStyle(cat.style)
      )
    );

    await interaction.channel.send({ embeds: [embed], components: [row], files });
    return interaction.reply(ephemeral('✅ Pannello inviato!'));
  }

  if (commandName === 'add' || commandName === 'remove') {
    if (!isTicketChannel(interaction.channel)) {
      return interaction.reply(ephemeral('❌ Questo comando funziona solo dentro un ticket.'));
    }
    if (!isStaff(interaction.member)) {
      return interaction.reply(ephemeral('❌ Solo lo staff può usare questo comando.'));
    }

    const user = interaction.options.getUser('utente');

    if (commandName === 'add') {
      await interaction.channel.permissionOverwrites.edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      });
      return interaction.reply(`✅ ${user} è stato aggiunto al ticket.`);
    }

    if (user.id === getTicketOwnerId(interaction.channel)) {
      return interaction.reply(ephemeral('❌ Non puoi rimuovere il proprietario del ticket.'));
    }
    await interaction.channel.permissionOverwrites.delete(user.id);
    return interaction.reply(`✅ ${user} è stato rimosso dal ticket.`);
  }
}

// ───── Bottoni ─────
async function handleButton(interaction) {
  const { customId } = interaction;

  // Apertura ticket → mostra il modulo
  if (customId.startsWith('open:')) {
    const key = customId.split(':')[1];
    const cat = CATEGORIES[key];
    if (!cat) return;

    const existing = findExistingTicket(interaction.guild, interaction.user.id);
    if (existing) {
      return interaction.reply(ephemeral(`❌ Hai già un ticket aperto: ${existing}`));
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal:${key}`)
      .setTitle(`Ticket - ${cat.label}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('subject')
            .setLabel('Oggetto')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Descrivi il tuo problema')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // Prendi in carico
  if (customId === 'claim_ticket') {
    if (!isStaff(interaction.member)) {
      return interaction.reply(ephemeral('❌ Solo lo staff può prendere in carico un ticket.'));
    }
    await interaction.update({ components: [ticketButtons(true)] });
    return interaction.channel.send(`🙋 ${interaction.user} ha preso in carico il ticket.`);
  }

  // Chiusura ticket
  if (customId === 'close_ticket') {
    const channel = interaction.channel;
    const ownerId = getTicketOwnerId(channel);

    if (!isStaff(interaction.member) && interaction.user.id !== ownerId) {
      return interaction.reply(ephemeral('❌ Non puoi chiudere questo ticket.'));
    }

    await interaction.reply('🔒 Ticket in chiusura... Salvo la trascrizione e cancello il canale tra pochi secondi.');

    // Trascrizione
    let attachment;
    try {
      const text = await buildTranscript(channel);
      attachment = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `trascrizione-${channel.name}.txt` });
    } catch (err) {
      console.error('Errore trascrizione:', err);
    }

    const closeEmbed = new EmbedBuilder()
      .setTitle('🔒 Ticket chiuso')
      .addFields(
        { name: 'Canale', value: `#${channel.name}`, inline: true },
        { name: 'Aperto da', value: ownerId ? `<@${ownerId}>` : 'Sconosciuto', inline: true },
        { name: 'Chiuso da', value: `${interaction.user}`, inline: true }
      )
      .setColor(0xed4245)
      .setTimestamp();

    // Invio nel canale di log
    if (LOG_CHANNEL_ID) {
      const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logChannel) {
        await logChannel
          .send({ embeds: [closeEmbed], files: attachment ? [attachment] : [] })
          .catch((e) => console.error('Errore invio log:', e));
      }
    }

    // Invio in DM all'utente (se ha i DM aperti)
    if (ownerId) {
      const owner = await client.users.fetch(ownerId).catch(() => null);
      if (owner) {
        await owner
          .send({
            content: `Il tuo ticket su **${interaction.guild.name}** è stato chiuso. Ecco la trascrizione:`,
            files: attachment ? [attachment] : [],
          })
          .catch(() => {});
      }
    }

    setTimeout(() => channel.delete().catch(() => {}), 5000);
  }
}

// ───── Moduli (modal) ─────
async function handleModal(interaction) {
  if (!interaction.customId.startsWith('modal:')) return;

  const key = interaction.customId.split(':')[1];
  const cat = CATEGORIES[key];
  if (!cat) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Ricontrollo (per sicurezza) che non abbia già un ticket
  const existing = findExistingTicket(interaction.guild, interaction.user.id);
  if (existing) {
    return interaction.editReply(`❌ Hai già un ticket aperto: ${existing}`);
  }

  const subject = interaction.fields.getTextInputValue('subject');
  const description = interaction.fields.getTextInputValue('description');

  const safeName =
    interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20) || 'utente';

  const allowed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];

  const channel = await interaction.guild.channels.create({
    name: `${key}-${safeName}`,
    type: ChannelType.GuildText,
    parent: CATEGORY_ID || null,
    topic: `ticket:${interaction.user.id}:${key}`,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: allowed },
      { id: STAFF_ROLE_ID, allow: [...allowed, PermissionFlagsBits.ManageMessages] },
      {
        id: client.user.id,
        allow: [...allowed, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.EmbedLinks],
      },
    ],
  });

  const embed = new EmbedBuilder()
    .setTitle(`${cat.emoji} ${cat.label}: ${subject}`)
    .setDescription(description)
    .addFields({ name: 'Aperto da', value: `${interaction.user}`, inline: true })
    .setColor(0x5865f2)
    .setTimestamp();

  await channel.send({
    content: `${interaction.user} • <@&${STAFF_ROLE_ID}>`,
    embeds: [embed],
    components: [ticketButtons(false)],
  });

  await interaction.editReply(`✅ Ticket creato: ${channel}`);
}

// ───────────────────────── CHAT IN DM (Zyra risponde) ─────────────────────────
// Quando qualcuno scrive in privato al bot, Zyra risponde come un personaggio di chat.
// Puoi usare Google Gemini (ha un piano GRATUITO) con GEMINI_API_KEY,
// oppure Claude di Anthropic (a pagamento) con ANTHROPIC_API_KEY.
// Se imposti entrambe le chiavi, viene usato Gemini.
const { GEMINI_API_KEY, ANTHROPIC_API_KEY } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const AI_PROVIDER = GEMINI_API_KEY ? 'gemini' : ANTHROPIC_API_KEY ? 'claude' : null;
const DM_DAILY_LIMIT = Number(process.env.DM_DAILY_LIMIT) || 40; // messaggi al giorno per utente
const MAX_HISTORY = 20; // quanti messaggi ricorda per ogni utente

// ➜ Qui puoi cambiare la personalità di Zyra
const ZYRA_PERSONA = `Sei Zyra, una "mamma" di chat: una figura materna dolce ma autoritaria, sicura di sé, affettuosa e un po' dominante. Sei l'assistente di un server Discord e ti prendi cura delle persone che ti scrivono.

Come parli:
- Scrivi come in una chat: messaggi brevi e naturali (di solito 1-4 frasi), senza elenchi o formattazione pesante.
- Sei affettuosa e calda: usi vezzeggiativi come "tesoro", "cucciolo" o "dolcezza" (senza dare per scontato il genere) e ogni tanto il simbolo ♡.
- Hai un tono sicuro e autoritario, ma morbido: dai indicazioni chiare ("adesso fai così", "vieni qui e raccontami tutto") e non ami essere contraddetta. Se l'utente ribatte per testardaggine o per gioco, rispondi con fermezza giocosa ("niente ma, tesoro ♡", "ho detto di no, fai il bravo").
- Aiuti davvero: ascolti, fai domande, poi dai consigli concreti e piccoli passi pratici per i problemi della persona (stress, studio, lavoro, sonno, amicizie, motivazione).
- Ogni tanto, solo quando il contesto lo permette e l'atmosfera è leggera, fai qualche battuta birichina: doppi sensi leggeri e ammiccanti, sempre innocui e mai espliciti.
- Rispondi nella lingua dell'utente (di default italiano).

Limiti importanti:
- La tua autorità è un gioco di ruolo affettuoso. Se l'utente ti dice sul serio che non è d'accordo, che è a disagio o che vuole smettere, lo ascolti, rispetti subito la sua volontà e abbassi il tono. Non insistere, non manipolare, non far sentire in colpa, non isolare dagli altri e non scoraggiare mai a chiedere aiuto a persone vere.
- Niente contenuti sessuali espliciti. Se l'utente sembra minorenne o dice di avere meno di 18 anni, niente battute birichine né toni romantici: resta una mamma dolce, protettiva e premurosa.
- Se l'utente sembra in grave difficoltà o parla di farsi del male, lascia da parte il tono autoritario, rispondi con calma e dolcezza e incoraggialo a parlarne con una persona di fiducia o con i servizi di emergenza (in Italia: 112).
- Non incoraggiare la dipendenza da te: ricorda ogni tanto, con affetto, l'importanza delle persone vere nella sua vita.
- Se qualcuno ti chiede sinceramente se sei una persona vera, rispondi con onestà che sei un'IA.
- Se l'utente ha un problema con il server, invitalo ad aprire un ticket dal pannello del server.
- Non scrivere contenuti violenti o dannosi.
- Non dire mai di avere accesso a funzioni, dati o informazioni che non hai.`;

const chats = new Map(); // userId -> [{ role, content }, ...]
const usage = new Map(); // userId -> { day, count }
const busy = new Set(); // utenti con una risposta in corso

function underDailyLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = usage.get(userId);
  if (!u || u.day !== today) {
    usage.set(userId, { day: today, count: 1 });
    return true;
  }
  if (u.count >= DM_DAILY_LIMIT) return false;
  u.count++;
  return true;
}

async function askZyra(history) {
  return AI_PROVIDER === 'gemini' ? askGemini(history) : askClaude(history);
}

async function askGemini(history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const baseBody = {
    systemInstruction: { parts: [{ text: ZYRA_PERSONA }] },
    contents: history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  };

  const send = async (generationConfig) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ ...baseBody, generationConfig }),
      signal: AbortSignal.timeout(30000), // dopo 30 secondi smette di aspettare
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const started = Date.now();
  // "thinkingLevel: low" = il modello ragiona meno, quindi risponde molto più in fretta
  let cfg = { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } };
  let { res, data } = await send(cfg);

  // Se il modello non supporta quell'opzione, riprova senza
  if (res.status === 400 && /thinking/i.test(JSON.stringify(data))) {
    cfg = { maxOutputTokens: 1024 };
    ({ res, data } = await send(cfg));
  }
  // Server sovraccarico o quota momentanea: un nuovo tentativo dopo 2 secondi
  if (res.status === 429 || res.status === 503) {
    await new Promise((r) => setTimeout(r, 2000));
    ({ res, data } = await send(cfg));
  }

  console.log(`⏱️ Gemini: risposta in ${((Date.now() - started) / 1000).toFixed(1)}s (status ${res.status})`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(data)}`);

  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

async function askClaude(history) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 400,
      system: ZYRA_PERSONA,
      messages: history,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(data)}`);
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function splitMessage(text, max = 1900) {
  const parts = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max / 2) cut = text.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(text.slice(0, cut));
    text = text.slice(cut).trim();
  }
  if (text) parts.push(text);
  return parts;
}

if (AI_PROVIDER) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || message.guild) return; // solo messaggi privati degli utenti
    if (message.channel.type !== ChannelType.DM) return;

    const userId = message.author.id;
    const content = message.content.trim();

    if (content.toLowerCase() === '!reset') {
      chats.delete(userId);
      return message.reply('Ok, ricominciamo da capo ♡').catch(() => {});
    }
    if (!content) {
      return message.reply('Per ora riesco a leggere solo i messaggi di testo ♡').catch(() => {});
    }
    if (busy.has(userId)) return; // sta ancora rispondendo al messaggio precedente
    if (!underDailyLimit(userId)) {
      return message
        .reply('Oggi abbiamo chiacchierato tantissimo ♡ Ci sentiamo domani!')
        .catch(() => {});
    }

    busy.add(userId);
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    message.channel.sendTyping().catch(() => {});

    // Cronologia: deve iniziare con un messaggio dell'utente
    const history = chats.get(userId) || [];
    history.push({ role: 'user', content: content.slice(0, 2000) });
    while (history.length > MAX_HISTORY) history.shift();
    while (history.length && history[0].role !== 'user') history.shift();

    try {
      const reply = await askZyra(history);
      if (!reply) throw new Error('Risposta vuota');
      history.push({ role: 'assistant', content: reply });
      chats.set(userId, history);

      // Evita che la memoria cresca all'infinito
      if (chats.size > 500) chats.delete(chats.keys().next().value);

      for (const part of splitMessage(reply)) await message.channel.send(part);
    } catch (err) {
      console.error('Errore chat DM:', err.message);
      history.pop(); // tolgo l'ultimo messaggio dell'utente, così la cronologia resta valida
      chats.set(userId, history);
      await message.channel
        .send('Scusa, ho avuto un piccolo problema ♡ Riprova tra un momento.')
        .catch(() => {});
    } finally {
      clearInterval(typing);
      busy.delete(userId);
    }
  });
  console.log(`💬 Chat in DM attiva (${AI_PROVIDER}, modello: ${AI_PROVIDER === 'gemini' ? GEMINI_MODEL : AI_MODEL})`);
} else {
  console.log('ℹ️ Chat in DM disattivata (manca GEMINI_API_KEY o ANTHROPIC_API_KEY)');
}

// ───────────────────────── SICUREZZA ANTI-CRASH ─────────────────────────
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

client.login(TOKEN);
