// Posts a memo-only transaction from the desk wallet so every settlement has
// its reason readable on Solana Explorer. Disabled unless RECEIPT_KEY is set.
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import bs58 from 'bs58';

const RPC_URL = process.env.RECEIPT_RPC_URL;
// Legacy memo program: rendered by Solana Explorer and most indexers.
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const AccountRole = { READONLY_SIGNER: 2 };

function memoInstruction(memo, signer) {
  return {
    programAddress: MEMO_PROGRAM,
    accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }],
    data: new TextEncoder().encode(memo),
  };
}
let ctx;

async function context() {
  if (ctx) return ctx;
  const raw = process.env.RECEIPT_KEY;
  if (!raw || !RPC_URL) return undefined;
  const bytes = raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim());
  const signer = await createKeyPairSignerFromBytes(bytes);
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(process.env.RECEIPT_WS_URL ?? RPC_URL.replace(/^http/, 'ws'));
  ctx = { signer, rpc, send: sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions }) };
  return ctx;
}

export async function postReceipt(memo) {
  const c = await context();
  if (!c) return undefined;
  const { value: blockhash } = await c.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(c.signer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    m => appendTransactionMessageInstructions([memoInstruction(memo, c.signer)], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await c.send(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}
