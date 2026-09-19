import { createApiServer, ChatStore, normalizeJid } from '../api.mjs';
import assert from 'node:assert';

async function runTests() {
  console.log('Starting WhatsApp Chat API test suite...');

  // 1. Test JID normalizer
  assert.strictEqual(normalizeJid('+1 (234) 567-890'), '1234567890@s.whatsapp.net');
  assert.strictEqual(normalizeJid('1234567890@s.whatsapp.net'), '1234567890@s.whatsapp.net');
  assert.strictEqual(normalizeJid('120363000@g.us'), '120363000@g.us');
  console.log('✓ JID normalizer tests passed');

  // 2. Test ChatStore with contact and LID resolution
  const store = new ChatStore();
  store.recordLidMapping('11223344@lid', '1234567890@s.whatsapp.net');
  store.recordContact({
    id: '1234567890@s.whatsapp.net',
    name: 'Alice Smith',
    notify: 'Alice',
    phone: '+1234567890',
  });

  // Verify LID resolves to Alice's name and phone
  assert.strictEqual(store.resolveDisplayName('11223344@lid'), 'Alice Smith');
  assert.strictEqual(store.getContacts().length, 2); // both JID and LID mapped

  store.recordMessage({
    id: 'msg_1',
    chatId: '11223344@lid',
    senderId: '11223344@lid',
    senderName: 'Alice',
    fromMe: false,
    timestamp: 1000,
    type: 'text',
    text: 'Hello from Alice via LID',
  });

  const chats = store.getChats();
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].id, '11223344@lid');
  assert.strictEqual(chats[0].name, 'Alice Smith'); // Resolved contact name, not opaque ID!
  assert.strictEqual(chats[0].phone, '+1234567890'); // Resolved phone number!
  assert.strictEqual(chats[0].unreadCount, 1);
  console.log('✓ ChatStore & LID contact resolution passed');

  // 3. Mock Baileys socket
  const sentMessages = [];
  const presenceUpdates = [];
  const readReceipts = [];

  const mockSocket = {
    user: { id: '9876543210:0@s.whatsapp.net' },
    sendMessage: async (jid, content, options) => {
      const id = `mock_msg_${Date.now()}`;
      sentMessages.push({ jid, content, options, id });
      return { key: { id, remoteJid: jid } };
    },
    sendPresenceUpdate: async (action, jid) => {
      presenceUpdates.push({ action, jid });
    },
    readMessages: async (keys) => {
      readReceipts.push(...keys);
    },
    onWhatsApp: async (phone) => {
      if (phone.includes('9999999999')) {
        return [{ jid: '9999999999@s.whatsapp.net', exists: true }];
      }
      return [{ jid: `${phone}@s.whatsapp.net`, exists: true }];
    },
  };

  const token = 'test-secret-token-12345';
  const api = createApiServer({
    getSocket: () => mockSocket,
    token,
    store,
    logger: { log: () => {}, error: () => {} },
  });

  const { port } = await api.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    // 4. Test GET /openapi.json (public)
    const openApiRes = await fetch(`${baseUrl}/openapi.json`);
    assert.strictEqual(openApiRes.status, 200);
    const spec = await openApiRes.json();
    assert.strictEqual(spec.openapi, '3.1.0');
    assert(spec.paths['/contacts']);
    assert(spec.paths['/contacts/search']);
    assert(spec.paths['/chats/search']);
    assert(spec.paths['/messages/send']);
    assert(spec.paths['/messages/reply']);
    assert(spec.paths['/messages/react']);
    console.log('✓ OpenAPI endpoint passed');

    // 5. Test GET /docs (public)
    const docsRes = await fetch(`${baseUrl}/docs`);
    assert.strictEqual(docsRes.status, 200);
    const html = await docsRes.text();
    assert(html.includes('SwaggerUIBundle'));
    console.log('✓ Swagger UI /docs endpoint passed');

    // 6. Test Auth on /health
    const unauthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(unauthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(authRes.status, 200);
    const healthData = await authRes.json();
    assert.strictEqual(healthData.status, 'ok');
    assert.strictEqual(healthData.connected, true);
    assert.strictEqual(healthData.phone, '9876543210');
    assert.strictEqual(healthData.chatsCount, 1);
    assert(healthData.contactsCount >= 1);
    console.log('✓ Health & Bearer authentication passed');

    // 7. Test GET /contacts
    const contactsRes = await fetch(`${baseUrl}/contacts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(contactsRes.status, 200);
    const contactsData = await contactsRes.json();
    assert(contactsData.contacts.length >= 1);
    const aliceContact = contactsData.contacts.find((c) => c.name === 'Alice Smith');
    assert(aliceContact);
    assert.strictEqual(aliceContact.phone, '+1234567890');
    console.log('✓ GET /contacts passed');

    // 8. Test GET /contacts/search?q=Alice
    const searchAliceRes = await fetch(`${baseUrl}/contacts/search?q=Alice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(searchAliceRes.status, 200);
    const searchAliceData = await searchAliceRes.json();
    assert.strictEqual(searchAliceData.query, 'Alice');
    assert(searchAliceData.contacts.length >= 1);
    assert.strictEqual(searchAliceData.chats.length, 1);
    assert.strictEqual(searchAliceData.chats[0].name, 'Alice Smith');
    console.log('✓ GET /contacts/search by name passed');

    // 9. Test GET /contacts/search?q=9999999999 (onWhatsApp verification)
    const searchPhoneRes = await fetch(`${baseUrl}/contacts/search?q=9999999999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(searchPhoneRes.status, 200);
    const searchPhoneData = await searchPhoneRes.json();
    assert(searchPhoneData.verified);
    assert.strictEqual(searchPhoneData.verified.exists, true);
    assert.strictEqual(searchPhoneData.verified.jid, '9999999999@s.whatsapp.net');
    console.log('✓ GET /contacts/search onWhatsApp verification passed');

    // 10. Test GET /chats & GET /chats/search
    const chatsRes = await fetch(`${baseUrl}/chats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(chatsRes.status, 200);
    const chatsData = await chatsRes.json();
    assert.strictEqual(chatsData.chats.length, 1);
    assert.strictEqual(chatsData.chats[0].name, 'Alice Smith');
    assert.strictEqual(chatsData.chats[0].phone, '+1234567890');

    const searchChatsRes = await fetch(`${baseUrl}/chats/search?q=Alice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(searchChatsRes.status, 200);
    const searchChatsData = await searchChatsRes.json();
    assert.strictEqual(searchChatsData.chats.length, 1);
    console.log('✓ GET /chats and GET /chats/search passed');

    // 11. Test GET /chats/:chatId/messages
    const msgsRes = await fetch(`${baseUrl}/chats/11223344%40lid/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(msgsRes.status, 200);
    const msgsData = await msgsRes.json();
    assert.strictEqual(msgsData.messages.length, 1);
    assert.strictEqual(msgsData.messages[0].text, 'Hello from Alice via LID');
    console.log('✓ GET /chats/:chatId/messages passed');

    // 12. Test POST /messages/send
    const sendRes = await fetch(`${baseUrl}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+1234567890', text: 'Hi Alice!' }),
    });
    assert.strictEqual(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.strictEqual(sendData.status, 'sent');
    assert.strictEqual(sendData.chatId, '1234567890@s.whatsapp.net');
    console.log('✓ POST /messages/send passed');

    // 13. Test POST /messages/reply
    const replyRes = await fetch(`${baseUrl}/messages/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '11223344@lid',
        text: 'This is a reply to Alice',
        quotedMessageId: 'msg_1',
      }),
    });
    assert.strictEqual(replyRes.status, 200);
    const replyData = await replyRes.json();
    assert.strictEqual(replyData.status, 'sent');
    console.log('✓ POST /messages/reply passed');

    // 14. Test POST /messages/react
    const reactRes = await fetch(`${baseUrl}/messages/react`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '11223344@lid',
        messageId: 'msg_1',
        emoji: '👍',
      }),
    });
    assert.strictEqual(reactRes.status, 200);
    console.log('✓ POST /messages/react passed');

    // 15. Test POST /chats/:chatId/presence and /read
    const presenceRes = await fetch(`${baseUrl}/chats/11223344%40lid/presence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'composing' }),
    });
    assert.strictEqual(presenceRes.status, 200);

    const readRes = await fetch(`${baseUrl}/chats/11223344%40lid/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'msg_1' }),
    });
    assert.strictEqual(readRes.status, 200);
    assert.strictEqual(store.getChats()[0].unreadCount, 0);
    console.log('✓ Presence and read passed');

    console.log('\nAll 15 API test scenarios passed successfully!');
  } finally {
    await api.close();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
