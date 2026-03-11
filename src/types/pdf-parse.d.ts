declare module 'pdf-parse' {
  function pdfParse(dataBuffer: Buffer): Promise<{ text: string; [key: string]: unknown }>
  export default pdfParse
}
