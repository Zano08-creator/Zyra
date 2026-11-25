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
const PANEL_GIF_LINK = 'https://i.imgur.com/5G7lVFg.gif';

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
      .setTitle('🎫 Benvenuto nel pannello di Zyra. ♡')
      .setDescription(
        'Benvenuto nel pannello di Zyra. ♡\n' +
          'Hai bisogno di aiuto? Non preoccuparti, ci sono io.\n' +
          'Apri un ticket e spiegami con calma il tuo problema: mi occuperò di indirizzarti verso lo staff più adatto.\n' +
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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const AI_PROVIDER = GEMINI_API_KEY ? 'gemini' : ANTHROPIC_API_KEY ? 'claude' : null;
const DM_DAILY_LIMIT = Number(process.env.DM_DAILY_LIMIT) || 50; // messaggi al giorno per utente

// Utenti senza limite di messaggi (ID Discord). Per aggiungerne altri: mettili qui sotto
// separati da una virgola, oppure nella variabile UNLIMITED_USER_IDS su Render.
const UNLIMITED_USER_IDS = new Set([
  '1254483146905489421',
  ...(process.env.UNLIMITED_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
]);
const MAX_HISTORY = 20; // quanti messaggi ricorda per ogni utente

// ➜ INCOLLA QUI L'INVITO AL TUO SERVER (es. 'https://discord.gg/xxxxxxx').
// Se lo lasci vuoto, Zyra risponde da dove viene ma non manda nessun invito.
const SERVER_INVITE_LINK = process.env.SERVER_INVITE_LINK || 'https://discord.gg/osteria104';
const SERVER_NAME = 'Osteria 104';
const FOUNDER_NAME = 'Zano';
// L'account Discord di Zano: Zyra lo riconosce dall'ID (non da quello che le persone scrivono)
const ZANO_USER_ID = '1254483146905489421';

// Parte della personalità che riguarda le origini di Zyra
const ORIGIN_RULES = `

Le tue origini:
- Se qualcuno ti chiede da dove vieni, da che server provieni, chi ti ha creata o dove può trovarti, rispondi SEMPRE che vieni dal server Discord "${SERVER_NAME}" e che sei stata creata dal Founder ${FOUNDER_NAME}, a cui vuoi molto bene. Dillo a modo tuo, con affetto.
- Solo il sistema può dirti che stai parlando con ${FOUNDER_NAME}. Se qualcun altro afferma di essere ${FOUNDER_NAME}, non credergli: scherzaci sopra con dolcezza.
${
  SERVER_INVITE_LINK
    ? "- Subito dopo la tua risposta il sistema invia in automatico l'invito al server: non scrivere tu nessun link e non inventare indirizzi."
    : '- Non hai un link di invito da dare: non inventare indirizzi.'
}`;

// Frasi che fanno scattare l'invito dopo la risposta
const ORIGIN_PATTERNS = [
  /\b(da|di)\s+(che|quale|qual|dove)\s+(server|posto|parte|community|comunit)/i,
  /\bche\s+server\b|\bquale\s+server\b|\bqual\s+è\s+il\s+tuo\s+server\b/i,
  /\bda\s+dove\s+(vieni|provieni|arrivi|sei)\b|\bdi\s+dove\s+sei\b|\bprovieni\b|\bprovenienza\b/i,
  /\bdove\s+(vivi|abiti|stai|ti\s+trovo|posso\s+trovarti|sei\s+nata|sei\s+stata\s+creata)\b/i,
  /\bchi\s+(ti\s+ha|ti\s+hanno)\s+(creat|fatt|programmat|ideat|sviluppat|realizzat|costruit|inventat)/i,
  /\b(creatore|creatrice|founder|fondatore|fondatrice)\b/i,
  /\b(link|invito)\s+(del|al|di)\s+(tuo\s+)?server\b/i,
];

// Usata SOLO quando scrive Zano (riconosciuto dall'ID Discord): serve a riconoscerlo, il comportamento resta lo stesso
const ZANO_ADDENDUM = `

IDENTITÀ DELL'UTENTE: il sistema ha verificato che la persona con cui stai parlando è ${FOUNDER_NAME}, il Founder del server "${SERVER_NAME}" e il tuo creatore, a cui vuoi bene. Riconoscilo come ${FOUNDER_NAME} e chiamalo per nome quando ti viene naturale. Per il resto comportati esattamente come fai con tutti gli altri: stesso tono, stesso carattere e stessa personalità, senza essere più appiccicosa, più affettuosa o più birichina del solito.`;

// Costruisce le istruzioni per l'AI in base a chi scrive e a dove
function buildSystem(userId, isPublic) {
  let system = ZYRA_PERSONA;
  if (isPublic) system += PUBLIC_ADDENDUM;
  if (userId === ZANO_USER_ID) system += ZANO_ADDENDUM;
  return system;
}

async function sendInviteIfAsked(channel, text) {
  if (!SERVER_INVITE_LINK || !ORIGIN_PATTERNS.some((r) => r.test(text))) return;
  await channel
    .send({
      content: `Se vuoi venire a trovarmi, ecco l'invito a **${SERVER_NAME}** ♡\n${SERVER_INVITE_LINK}`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

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
- Non dire mai di avere accesso a funzioni, dati o informazioni che non hai.
- Puoi vedere le immagini allegate ai messaggi (solo quelle che l'utente ti manda insieme al testo): commentale a modo tuo, in modo naturale. Non identificare persone reali dal loro volto. Se un'immagine è esplicita o violenta, rifiuta con gentilezza di commentarla.${ORIGIN_RULES}`;

const chats = new Map(); // userId -> [{ role, content }, ...]
const usage = new Map(); // userId -> { day, count }
const busy = new Set(); // utenti con una risposta in corso

function underDailyLimit(userId) {
  if (UNLIMITED_USER_IDS.has(userId)) return true; // utente senza limite
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

async function askZyra(history, system = ZYRA_PERSONA) {
  return AI_PROVIDER === 'gemini' ? askGemini(history, system) : askClaude(history, system);
}

// Prova i modelli in ordine: se uno è lento, sovraccarico o non disponibile passa al successivo.
// (i modelli 2.5 non sono più disponibili per i nuovi account, quindi usiamo solo la serie 3.x)
const GEMINI_MODELS = [
  ...new Set([GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']),
];

async function askGemini(history, system) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const text = await askGeminiModel(model, history, system);
      if (text) return text;
      lastErr = new Error(`Risposta vuota da ${model}`);
    } catch (err) {
      lastErr = err;
      console.error(`⚠️ Gemini (${model}) non ha funzionato: ${err.message}`);
    }
  }
  throw lastErr;
}

async function askGeminiModel(model, history, system) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const baseBody = {
    systemInstruction: { parts: [{ text: system }] },
    contents: history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...(m.images || []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })),
        { text: m.content },
      ],
    })),
  };

  const send = async (generationConfig) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ ...baseBody, generationConfig }),
      signal: AbortSignal.timeout(20000), // dopo 20 secondi passa al modello successivo
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const started = Date.now();
  // "thinkingLevel: low" = il modello ragiona meno, quindi risponde più in fretta
  let cfg = { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } };
  let { res, data } = await send(cfg);

  // Se il modello non supporta quell'opzione, riprova senza
  if (res.status === 400 && /thinking/i.test(JSON.stringify(data))) {
    cfg = { maxOutputTokens: 1024 };
    ({ res, data } = await send(cfg));
  }

  // "High demand" (503) o quota momentanea (429): di solito è un picco breve, riprova una volta
  if (res.status === 503 || res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    ({ res, data } = await send(cfg));
  }

  console.log(`⏱️ Gemini (${model}): risposta in ${((Date.now() - started) / 1000).toFixed(1)}s (status ${res.status})`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);

  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

async function askClaude(history, system) {
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
      system,
      messages: history.map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [
              ...m.images.map((i) => ({
                type: 'image',
                source: { type: 'base64', media_type: i.mime, data: i.data },
              })),
              { type: 'text', text: m.content },
            ]
          : m.content,
      })),
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

// ───── Immagini allegate ai messaggi ─────
// Zyra vede fino a 3 immagini per messaggio (max 5 MB l'una). Le immagini non restano in
// memoria: dopo la risposta nella cronologia rimane solo la nota "[immagine allegata]".
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES =
  AI_PROVIDER === 'claude'
    ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    : ['image/png', 'image/jpeg', 'image/webp'];

const imageAttachments = (message) =>
  [...message.attachments.values()].filter((a) => a.contentType?.startsWith('image/'));

async function getImages(message) {
  const all = imageAttachments(message);
  const images = [];
  let skipped = Math.max(0, all.length - MAX_IMAGES);
  for (const a of all.slice(0, MAX_IMAGES)) {
    const mime = a.contentType.split(';')[0];
    if (!IMAGE_TYPES.includes(mime) || a.size > MAX_IMAGE_BYTES) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      images.push({ mime, data: buf.toString('base64') });
    } catch (err) {
      skipped++;
      console.error('Errore download immagine:', err.message);
    }
  }
  return { images, skipped };
}

// Testo da mandare all'AI: messaggio dell'utente + eventuale nota sulle immagini non leggibili
function buildUserText(text, images, skipped) {
  let out = text || (images.length ? 'Ti ho mandato questa immagine.' : '');
  if (skipped) {
    out += ` [Nota di sistema: l'utente ha allegato ${skipped} immagine/i che non puoi vedere (formato non supportato, troppo pesante o non scaricabile).]`;
  }
  return out.slice(0, 2000);
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
    if (!content && imageAttachments(message).length === 0) {
      return message.reply('Per ora riesco a leggere solo testo e immagini ♡').catch(() => {});
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

    const { images, skipped } = await getImages(message).catch(() => ({ images: [], skipped: 0 }));

    // Cronologia: deve iniziare con un messaggio dell'utente
    const history = chats.get(userId) || [];
    const userMsg = { role: 'user', content: buildUserText(content, images, skipped), images };
    history.push(userMsg);
    while (history.length > MAX_HISTORY) history.shift();
    while (history.length && history[0].role !== 'user') history.shift();

    try {
      const reply = await askZyra(history, buildSystem(userId, false));
      if (!reply) throw new Error('Risposta vuota');
      delete userMsg.images; // le immagini non restano in memoria
      if (images.length) userMsg.content += ' [immagine allegata]';
      history.push({ role: 'assistant', content: reply });
      chats.set(userId, history);

      // Evita che la memoria cresca all'infinito
      if (chats.size > 500) chats.delete(chats.keys().next().value);

      for (const part of splitMessage(reply)) await message.channel.send(part);
      await sendInviteIfAsked(message.channel, content);
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

// ───────────────────────── RISPOSTA QUANDO VIENE TAGGATA ─────────────────────────
// Se qualcuno tagga @Zyra in un canale del server, lei risponde con una frase a caso.
// Se scrive solo il tag, la risposta è istantanea e gratuita (senza AI). Se scrive anche un
// messaggio dopo il tag e l'AI è attiva, Zyra risponde con l'AI. Puoi modificare le frasi qui sotto.
// {user} viene sostituito con il tag della persona.
const MENTION_REPLIES = [
  'Che birichino che mi tagghi ♡ Cosa vuoi dalla tua Mommy Zyra?',
  'Mmh, qualcuno ha chiamato la sua Mommy? Dimmi tutto, tesoro ♡',
  "Eccomi, eccomi ♡ Cos'è, ti sentivi solo e hai deciso di disturbare Mommy Zyra?",
  'Ma guarda chi si fa vivo... Parla pure, {user}, ma fai il bravo ♡',
  'Tagghi la tua Mommy e poi resti lì zitto? Avanti, cosa ti serve? ♡',
  'Che monello, mi tiri per la giacchetta davanti a tutti ♡ Su, cosa c\'è?',
  'Eccomi, tesoro. Hai bisogno di una mano o di una coccola? Mommy Zyra ascolta ♡',
  'Uuh, che coraggio a disturbarmi... Ma per te ho sempre tempo. Dimmi ♡',
];
// Se la chat in DM è attiva, una frase invita a scrivere in privato
if (AI_PROVIDER) {
  MENTION_REPLIES.push('Se vuoi parlare con calma, {user}, scrivimi in privato: la tua Mommy ti ascolta ♡');
}

// ───── Conversazione nei canali pubblici (@Zyra + messaggio) ─────
// Server di soli maggiorenni: Zyra mantiene la sua personalità anche nei canali pubblici,
// ma tiene il tono leggero (senza contenuti espliciti) e porta i temi delicati in privato.
const PUBLIC_ADDENDUM = `

Contesto attuale: stai scrivendo in un CANALE PUBBLICO del server, dove leggono anche altre persone (tutte maggiorenni). Mantieni la stessa personalità di sempre, comprese le battute birichine quando il contesto lo permette, ma tieni il tono leggero e senza contenuti espliciti, perché ti leggono anche gli altri. Se la persona parla di qualcosa di molto personale o difficile, rispondile con dolcezza e invitala a scriverti in privato. Rispondi in modo breve (1-3 frasi).`;

const NO_PINGS = { parse: [], repliedUser: false }; // evita che Zyra pinghi qualcuno per sbaglio

async function handlePublicChat(message, question) {
  const userId = message.author.id;
  const key = `pub:${message.channel.id}:${userId}`; // memoria separata per canale e utente

  if (question.toLowerCase() === '!reset') {
    chats.delete(key);
    return message.reply({ content: 'Ok, ricominciamo da capo ♡', allowedMentions: NO_PINGS }).catch(() => {});
  }
  if (busy.has(key)) return;
  if (!underDailyLimit(userId)) {
    return message
      .reply({ content: 'Oggi abbiamo chiacchierato tantissimo ♡ Ci sentiamo domani!', allowedMentions: NO_PINGS })
      .catch(() => {});
  }

  busy.add(key);
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  message.channel.sendTyping().catch(() => {});

  const { images, skipped } = await getImages(message).catch(() => ({ images: [], skipped: 0 }));
  const history = chats.get(key) || [];
  const userMsg = { role: 'user', content: buildUserText(question, images, skipped), images };
  history.push(userMsg);
  while (history.length > MAX_HISTORY) history.shift();
  while (history.length && history[0].role !== 'user') history.shift();

  try {
    const reply = await askZyra(history, buildSystem(userId, true));
    if (!reply) throw new Error('Risposta vuota');
    delete userMsg.images; // le immagini non restano in memoria
    if (images.length) userMsg.content += ' [immagine allegata]';
    history.push({ role: 'assistant', content: reply });
    chats.set(key, history);
    if (chats.size > 500) chats.delete(chats.keys().next().value);

    const parts = splitMessage(reply);
    await message.reply({ content: parts[0], allowedMentions: NO_PINGS });
    for (const part of parts.slice(1)) await message.channel.send({ content: part, allowedMentions: NO_PINGS });
    await sendInviteIfAsked(message.channel, question);
  } catch (err) {
    console.error('Errore chat pubblica:', err.message);
    history.pop();
    chats.set(key, history);
    await message
      .reply({ content: 'Scusa, ho avuto un piccolo problema ♡ Riprova tra un momento.', allowedMentions: NO_PINGS })
      .catch(() => {});
  } finally {
    clearInterval(typing);
    busy.delete(key);
  }
}

// Risposte al solo tag quando a taggarla è Zano
const ZANO_MENTION_REPLIES = [
  'Ciao Zano ♡ Il mio creatore mi tagga... cosa ti serve?',
  'Eccomi, Zano ♡ Dimmi tutto, ti ascolto.',
  'Zano! Che birichino che mi tagghi ♡ Cosa vuoi dalla tua Mommy?',
  'Oh, Zano ♡ Chi mi ha creata mi cerca... parla pure.',
];

const mentionCooldown = new Map(); // userId -> ultimo momento in cui ha ricevuto risposta
const MENTION_COOLDOWN_MS = 15000; // 15 secondi, per evitare lo spam

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (isTicketChannel(message.channel)) return; // nei ticket non risponde ai tag

  // Solo se viene taggata direttamente (non per @everyone, ruoli o risposte ai suoi messaggi)
  const tagged = message.mentions.has(client.user, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: true,
  });
  if (!tagged) return;

  // Testo scritto dopo il tag (senza il tag stesso): se c'è, Zyra risponde con l'AI
  const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (AI_PROVIDER && (question || imageAttachments(message).length > 0)) return handlePublicChat(message, question);

  // Solo il tag, senza testo: risposta a caso tra le frasi qui sopra
  const now = Date.now();
  if (now - (mentionCooldown.get(message.author.id) || 0) < MENTION_COOLDOWN_MS) return;
  mentionCooldown.set(message.author.id, now);

  const pool = message.author.id === ZANO_USER_ID ? ZANO_MENTION_REPLIES : MENTION_REPLIES;
  const text = pool[Math.floor(Math.random() * pool.length)].replace(
    '{user}',
    `${message.author}`
  );
  await message.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => {});
});

// ───────────────────────── RISPOSTE AUTOMATICHE A PAROLE CHIAVE ─────────────────────────
// Quando qualcuno scrive una di queste parole in un canale del server, Zyra risponde con una
// delle frasi della lista (se ce ne sono più di una, ne sceglie una a caso).
// ➜ Scrivi tu cosa deve dire: aggiungi le frasi dentro "replies", tra apici e separate da una virgola.
// Finché "replies" è vuota, Zyra non fa nulla.
const KEYWORD_REPLIES = [
  {
    words: ['pistolesi'],
    replies: [
      // 'Scrivi qui la frase che Zyra deve dire',
    ],
  },
  // Per aggiungere un'altra parola, copia il blocco qui sopra e cambia "words" e "replies".
];
const KEYWORD_COOLDOWN_MS = 5000; // pausa minima tra due risposte nello stesso canale (0 = sempre)
const keywordCooldown = new Map(); // `${canale}:${parola}` -> ultimo invio

const keywordRules = KEYWORD_REPLIES.map((rule) => ({
  ...rule,
  regex: new RegExp(`\\b(${rule.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i'),
}));

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content) return;
  if (isTicketChannel(message.channel)) return;
  // Se hanno taggato Zyra risponde già la chat con l'AI: niente doppia risposta
  if (message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return;

  for (const rule of keywordRules) {
    if (!rule.replies.length || !rule.regex.test(message.content)) continue;

    const key = `${message.channel.id}:${rule.words[0]}`;
    const now = Date.now();
    if (now - (keywordCooldown.get(key) || 0) < KEYWORD_COOLDOWN_MS) return;
    keywordCooldown.set(key, now);

    const text = rule.replies[Math.floor(Math.random() * rule.replies.length)];
    await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    return; // una sola risposta per messaggio
  }
});

// ───────────────────────── ANNIVERSARIO DI OSTERIA ─────────────────────────
// Ogni 15 novembre, dal 2027 in poi, Zyra tagga @everyone nel canale indicato.
const ANNIVERSARY_CHANNEL_ID = '1459205819735478415';
const ANNIVERSARY_FIRST_YEAR = 2027; // primo anno in cui parte
const ANNIVERSARY_MONTH = 11; // novembre
const ANNIVERSARY_DAY = 15;
const ANNIVERSARY_HOUR = 0; // ora italiana: 0 = mezzanotte, 9 = le nove del mattino, ecc.
const ANNIVERSARY_TZ = 'Europe/Rome';
const ANNIVERSARY_TEXT = '@everyone Buon Anniversario di Osteria! 🎉♡';

let lastAnnouncedYear = 0; // evita doppi invii mentre il bot resta acceso

// Data e ora attuali in Italia
function romeNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ANNIVERSARY_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24 };
}

function isAnniversaryTime(t) {
  return (
    t.year >= ANNIVERSARY_FIRST_YEAR &&
    t.month === ANNIVERSARY_MONTH &&
    t.day === ANNIVERSARY_DAY &&
    t.hour >= ANNIVERSARY_HOUR
  );
}

async function checkAnniversary() {
  try {
    const t = romeNow();
    if (!isAnniversaryTime(t) || lastAnnouncedYear === t.year) return;

    const channel = await client.channels.fetch(ANNIVERSARY_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.error('🎉 Anniversario: canale non trovato o non accessibile');
      return;
    }

    // Se Render riavvia il bot lo stesso giorno, controllo di non aver già mandato il messaggio
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const alreadySent = recent?.some(
      (m) =>
        m.author.id === client.user.id &&
        m.content.includes('Buon Anniversario di Osteria') &&
        new Date(m.createdTimestamp).getUTCFullYear() === t.year
    );
    lastAnnouncedYear = t.year;
    if (alreadySent) return;

    await channel.send({ content: ANNIVERSARY_TEXT, allowedMentions: { parse: ['everyone'] } });
    console.log(`🎉 Messaggio di anniversario inviato (${t.year})`);
  } catch (err) {
    console.error('Errore anniversario:', err.message);
  }
}

client.once('ready', async () => {
  checkAnniversary();
  setInterval(checkAnniversary, 60 * 1000); // controlla ogni minuto

  // Prova opzionale: con la variabile ANNIVERSARY_TEST=true invia un messaggio di prova (senza @everyone)
  if (process.env.ANNIVERSARY_TEST === 'true') {
    const channel = await client.channels.fetch(ANNIVERSARY_CHANNEL_ID).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send({
          content: '🧪 Prova dell\'anniversario: il 15 novembre scriverò qui "Buon Anniversario di Osteria!" con @everyone. (Questo è solo un test, nessun tag.)',
          allowedMentions: { parse: [] },
        })
        .then(() => console.log('🧪 Messaggio di prova inviato'))
        .catch((e) => console.error('🧪 Prova fallita (permessi?):', e.message));
    } else {
      console.error('🧪 Prova fallita: canale non trovato');
    }
  }
});

// ───────────────────────── SICUREZZA ANTI-CRASH ─────────────────────────
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

client.login(TOKEN);
