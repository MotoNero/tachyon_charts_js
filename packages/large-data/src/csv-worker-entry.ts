// The module of a CSV parse worker: it parses the pieces csvToColumnFile sends and hands their rows back.
import { parseCsvPiece, type CsvLayout } from './csv-parse';

const scope = globalThis as unknown as Worker;

scope.addEventListener('message', (event: MessageEvent<{ bytes: Uint8Array; layout: CsvLayout }>) => {
  try {
    const piece = parseCsvPiece(event.data.bytes, event.data.layout);
    scope.postMessage(piece, [piece.values.buffer, piece.xs.buffer, piece.lineOfRow.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
