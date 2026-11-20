/**
 * Development seed: creates a demo owner and organisation, generating real keys exactly as
 * the browser would. Prints the password and recovery key once.
 *   npm run seed  ->  demo@inbox-os.local / demo-password-123
 */
import { deriveKeyFromSecret, deriveKeys, generateOrgKeypair, newKdfParams, seal, toB64, wrapSecret, getSodium } from '@inbox-os/shared';
import { sha256 } from '../crypto.js';
import { hashAuthKey } from '../auth/sessions.js';
import { one, pool, tx } from './pool.js';
import { migrate } from './migrate.js';

const EMAIL = 'demo@inbox-os.local';
const PASSWORD = 'demo-password-123';

async function main() {
  await migrate();
  if (await one('SELECT 1 FROM users WHERE email = $1', [EMAIL])) {
    console.log('Seed user already exists:', EMAIL);
    return;
  }
  const s = await getSodium();
  const kdf = await newKdfParams();
  const { authKey, wrapKey } = await deriveKeys(PASSWORD, kdf);
  const org = await generateOrgKeypair();
  const recoveryKey = await toB64(s.randombytes_buf(32));
  const recoveryProof = await toB64(await deriveKeyFromSecret(recoveryKey, 'recovery-proof'));
  const recoveryWrapped = await wrapSecret(org.privateKey, await deriveKeyFromSecret(recoveryKey, 'recovery'));

  await tx(async (db) => {
    const u = await one<{ id: string }>('INSERT INTO users (email, name, auth_hash, kdf_params) VALUES ($1,$2,$3,$4) RETURNING id', [EMAIL, 'Demo Owner', await hashAuthKey(authKey), JSON.stringify(kdf)], db);
    const o = await one<{ id: string }>('INSERT INTO organisations (name, public_key, recovery_wrapped_key, recovery_proof_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      ['Demo Ventures', org.publicKey, recoveryWrapped, sha256(recoveryProof)], db);
    await db.query(`INSERT INTO memberships (organisation_id, user_id, role, wrapped_org_key) VALUES ($1,$2,'owner',$3)`, [o!.id, u!.id, await wrapSecret(org.privateKey, wrapKey)]);
    for (const name of ['Brokerage', 'Agency']) {
      const w = await one<{ id: string }>('INSERT INTO workspaces (organisation_id, name) VALUES ($1,$2) RETURNING id', [o!.id, name], db);
      await db.query(`INSERT INTO agent_settings (workspace_id, organisation_id, permission_level) VALUES ($1,$2,'send_with_approval')`, [w!.id, o!.id]);
      await db.query('INSERT INTO voice_profiles (workspace_id, organisation_id, profile_sealed) VALUES ($1,$2,$3)',
        [w!.id, o!.id, await seal({ tone: 'Warm, concise, professional.', signature: `Best regards,\nDemo Owner\n${name}`, sampleText: '', language: 'en' }, org.publicKey)]);
    }
  });
  console.log(`Seeded ${EMAIL} / ${PASSWORD}\nRecovery key (store it safely, shown once): ${recoveryKey}`);
}

main().then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
