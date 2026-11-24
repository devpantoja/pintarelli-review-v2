import modules from './modules.json'
import page from './page.html'

/**
 * Checklist de revisão dos módulos do Pintarelli ERP.
 *
 * Tudo fica atrás de /r/<código>: quem não tem o link completo recebe 404.
 * Não há contas. Só responde quem recebeu um código pessoal de 8 dígitos,
 * cadastrado direto no banco (coluna people.secret). A página nunca devolve
 * os códigos: os outros veem apenas um número público e o nome.
 */

const ITEM_IDS = new Set(modules.flatMap((module) => module.items.map((item) => item.id)))
const CODE = /^\d{8}$/
const MAX_NOTE = 1500
const MAX_BODY = 8 * 1024

let schemaReady = null

function ensureSchema(db) {
  schemaReady ??= db
    .batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS people (
           pub INTEGER PRIMARY KEY AUTOINCREMENT,
           secret TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS answers (
           pub INTEGER NOT NULL REFERENCES people(pub),
           item_id TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('ok', 'change')),
           note TEXT NOT NULL DEFAULT '',
           at INTEGER NOT NULL,
           PRIMARY KEY (pub, item_id)
         )`
      ),
    ])
    .catch((error) => {
      schemaReady = null
      throw error
    })
  return schemaReady
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const fail = (message, status = 422) => json({ message }, status)

/** Comparação em tempo constante, para o código do link não vazar por tempo de resposta. */
function sameToken(given, expected) {
  if (!expected || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

async function personBySecret(db, secret) {
  if (!secret || !CODE.test(secret)) return null
  return db.prepare('SELECT pub, name FROM people WHERE secret = ?').bind(secret).first()
}

async function state(request, env) {
  const me = await personBySecret(env.DB, request.headers.get('x-person'))
  const [people, answers] = await env.DB.batch([
    env.DB.prepare('SELECT pub, name FROM people ORDER BY pub'),
    env.DB.prepare('SELECT pub, item_id, status, note, at FROM answers'),
  ])
  return json({
    modules,
    me: me ? { id: me.pub, name: me.name } : null,
    people: people.results.map((row) => ({ id: row.pub, name: row.name })),
    answers: answers.results.map((row) => ({
      person: row.pub,
      item: row.item_id,
      status: row.status,
      note: row.note,
      at: row.at,
    })),
  })
}

async function readBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY) return null
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

/** Confere o código pessoal e devolve quem é. Códigos são cadastrados fora da página. */
async function identify(request, env) {
  const me = await personBySecret(env.DB, request.headers.get('x-person'))
  if (!me) return fail('Código não reconhecido. Confira os 8 dígitos que você recebeu.', 401)
  return json({ id: me.pub, name: me.name })
}

async function answer(request, env) {
  const body = await readBody(request)
  const me = await personBySecret(env.DB, request.headers.get('x-person'))
  if (!me) return fail('Informe seu código de 8 dígitos antes de responder.', 401)
  if (!body || !ITEM_IDS.has(body.item)) return fail('Item não encontrado.', 404)

  if (body.status === null) {
    await env.DB.prepare('DELETE FROM answers WHERE pub = ? AND item_id = ?').bind(me.pub, body.item).run()
    return json({ ok: true })
  }
  if (body.status !== 'ok' && body.status !== 'change') return fail('Resposta inválida.')
  const note = body.status === 'change' && typeof body.note === 'string' ? body.note.trim() : ''
  if (body.status === 'change' && !note) return fail('Escreva o que deve mudar antes de salvar.')
  if (note.length > MAX_NOTE) return fail(`O texto passa de ${MAX_NOTE} caracteres.`)

  await env.DB.prepare(
    `INSERT INTO answers (pub, item_id, status, note, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pub, item_id) DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at`
  )
    .bind(me.pub, body.item, body.status, note, Date.now())
    .run()
  return json({ ok: true })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const [, prefix, token, ...rest] = url.pathname.split('/')
    if (url.pathname === '/') {
      // Quem digita só o domínio vê uma orientação, em vez de parecer que o site caiu.
      return new Response(
        '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Revisão Pintarelli ERP</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#1c1a33"><h1 style="font-size:1.4rem">Revisão Pintarelli ERP</h1><p>Esta página abre somente pelo link completo que você recebeu. Confira se o endereço foi copiado inteiro, até a barra final.</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } }
      )
    }
    if (prefix !== 'r' || !sameToken(token ?? '', env.ACCESS_TOKEN ?? '')) {
      return new Response('Não encontrado', { status: 404 })
    }
    const route = `${request.method} /${rest.join('/')}`

    if (route === 'GET /') {
      return new Response(page, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        },
      })
    }

    try {
      await ensureSchema(env.DB)
      if (route === 'GET /api/state') return await state(request, env)
      if (route === 'PUT /api/me') return await identify(request, env)
      if (route === 'PUT /api/answer') return await answer(request, env)
    } catch (error) {
      console.error(JSON.stringify({ message: 'request_failed', route, error: String(error) }))
      return fail('Erro no servidor. Tente de novo em instantes.', 500)
    }
    return new Response('Não encontrado', { status: 404 })
  },
}
