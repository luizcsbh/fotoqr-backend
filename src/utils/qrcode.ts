import QRCode from 'qrcode';

/**
 * Generates a base64 Data URL for a QR code representing the provided URL.
 *
 * @param url The target URL to encode in the QR code
 * @returns Promise<string> Base64 data URL (e.g. data:image/png;base64,...)
 */
export async function generateQRCode(url: string): Promise<string> {
  if (!url || typeof url !== 'string') {
    throw new Error('A URL para o QR Code é inválida ou não foi informada.');
  }

  try {
    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 2,
      width: 400,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    return dataUrl;
  } catch (error) {
    throw new Error(`Falha ao gerar QR Code: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}
