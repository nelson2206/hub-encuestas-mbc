// Texto de un documento Word (.docx). Un .docx es un ZIP: el contenido está en word/document.xml.
// Se lee solo el texto (párrafos, tablas, tabuladores); las imágenes y los diagramas dentro del Word no se leen.
// Sin dependencias: usa DecompressionStream, que ya trae Cloudflare Workers.

const MAX_XML = 20 * 1024 * 1024;   // tope de lo que se descomprime (protege de archivos que se expanden demasiado)
export const MAX_TEXTO_DOCX = 40000; // caracteres que se mandan a la IA

async function inflar(datos) {
  const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const lector = flujo.getReader(), partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > MAX_XML) { await lector.cancel(); throw new Error('El documento es demasiado grande'); }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let pos = 0;
  partes.forEach(p => { todo.set(p, pos); pos += p.length; });
  return todo;
}

// Busca una entrada en el directorio central del ZIP y devuelve su contenido descomprimido.
async function leerEntrada(buf, nombre) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let fin = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('No es un documento Word válido');
  const n = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.byteLength || v.getUint32(p, true) !== 0x02014b50) break;
    const metodo = v.getUint16(p + 10, true), comp = v.getUint32(p + 20, true);
    const lnom = v.getUint16(p + 28, true), lext = v.getUint16(p + 30, true), lcom = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nom = dec.decode(u8.subarray(p + 46, p + 46 + lnom));
    if (nom === nombre) {
      if (v.getUint32(local, true) !== 0x04034b50) throw new Error('No es un documento Word válido');
      const ini = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const datos = u8.subarray(ini, ini + comp);
      if (metodo === 0) return datos;
      if (metodo === 8) return inflar(datos);
      throw new Error('No es un documento Word válido');
    }
    p += 46 + lnom + lext + lcom;
  }
  return null;
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function textoDeXmlWord(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>\s*<\/w:tc>/g, ' | ')   // celda de tabla: sus columnas quedan en una línea
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTIDADES[e] || m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Devuelve el texto del .docx (recortado a MAX_TEXTO_DOCX) y si se recortó.
export async function textoDeDocx(buf) {
  const xml = await leerEntrada(buf, 'word/document.xml');
  if (!xml) throw new Error('No es un documento Word válido');
  const texto = textoDeXmlWord(new TextDecoder().decode(xml));
  return texto.length > MAX_TEXTO_DOCX ? { texto: texto.slice(0, MAX_TEXTO_DOCX), recortado: true } : { texto, recortado: false };
}
