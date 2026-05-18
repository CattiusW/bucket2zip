import { NextResponse, NextRequest } from 'next/server';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Initialize the Cloudflare R2 Client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

/**
 * HELPER: Validates the Basic Auth header against environment variables
 */
function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  try {
    // Parse the "Basic base64encoding" header
    const authValue = authHeader.split(' ')[1];
    const decoded = Buffer.from(authValue, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');

    const expectedUser = process.env.APP_USERNAME;
    const expectedPass = process.env.APP_PASSWORD;

    // Ensure credentials exist in env and match perfectly
    return !!expectedUser && !!expectedPass && username === expectedUser && password === expectedPass;
  } catch {
    return false;
  }
}

/**
 * HELPER: Returns a 401 Unauthorized response to trigger the browser login popup
 */
function sendUnauthorizedResponse() {
  return new NextResponse('Authentication Required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure S3/R2 Zipper", charset="UTF-8"',
    },
  });
}

/**
 * 1. SECURE BACKEND API: Fetches file listings and presigned URLs
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return sendUnauthorizedResponse();
  }

  try {
    const bucketName = process.env.R2_BUCKET_NAME;
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    const { Contents } = await r2Client.send(command);

    if (!Contents) {
      return NextResponse.json({ files: [] });
    }

    const filePromises = Contents.map(async (file) => {
      const getObjectCmd = new GetObjectCommand({ Bucket: bucketName, Key: file.Key });
      const url = await getSignedUrl(r2Client, getObjectCmd, { expiresIn: 3600 });
      return { key: file.Key, url };
    });

    const files = await Promise.all(filePromises);
    return NextResponse.json({ files });
  } catch (error) {
    console.error('R2 Error:', error);
    return NextResponse.json({ error: 'Failed to fetch files from R2' }, { status: 500 });
  }
}

/**
 * 2. SECURE FRONTEND UI: Serves the HTML page after authentication passes
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return sendUnauthorizedResponse();
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Secure R2 Bucket Zipper</title>
      <script src="https://tailwindcss.com"></script>
      <script src="https://cloudflare.com"></script>
      <script src="https://cloudflare.com"></script>
    </head>
    <body class="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-6">
      
      <div class="p-8 bg-white rounded-xl shadow-md max-w-md w-full text-center">
        <div class="flex items-center justify-center mb-2">
          <span class="text-2xl mr-2">🔒</span>
          <h1 class="text-2xl font-bold text-gray-800">Secure Zipper</h1>
        </div>
        <p class="text-gray-600 mb-6 text-sm">
          Authenticated successfully. Click below to download all contents of your R2 bucket.
        </p>
        
        <button
          id="zipBtn"
          onclick="downloadAndZip()"
          class="w-full py-3 px-4 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-sm"
        >
          Download All as ZIP
        </button>

        <p id="status" class="hidden mt-4 text-xs font-mono text-gray-500 bg-gray-100 p-2 rounded break-all"></p>
      </div>

      <script>
        const btn = document.getElementById('zipBtn');
        const status = document.getElementById('status');

        function updateStatus(text, show = true) {
          status.textContent = text;
          if (show) status.classList.remove('hidden');
        }

        async function downloadAndZip() {
          btn.disabled = true;
          btn.className = "w-full py-3 px-4 rounded-lg font-medium text-white bg-blue-400 cursor-not-allowed";
          updateStatus('Requesting file access from R2...');

          try {
            // Sends the POST request to this exact file. 
            // The browser automatically passes the Basic Auth header along.
            const response = await fetch('/api/download', { method: 'POST' });
            
            if (response.status === 401) {
              throw new Error('Session expired or unauthorized.');
            }
            
            const data = await response.json();

            if (data.error) throw new Error(data.error);
            if (!data.files || data.files.length === 0) {
              updateStatus('No files found in the bucket.');
              return;
            }

            const zip = new JSZip();
            const files = data.files;

            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              updateStatus(\`Downloading file \${i + 1} of \${files.length}: \${file.key}\`);

              const fileResponse = await fetch(file.url);
              const blob = await fileResponse.blob();
              zip.file(file.key, blob);
            }

            updateStatus('Generating ZIP archive...');
            const zipContent = await zip.generateAsync({ type: 'blob' });
            
            updateStatus('Starting download save...');
            saveAs(zipContent, 'r2-bucket-files.zip');
            updateStatus('Download complete!');
          } catch (error) {
            console.error(error);
            updateStatus('An error occurred: ' + error.message);
          } finally {
            btn.disabled = false;
            btn.className = "w-full py-3 px-4 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors";
          }
        }
      </script>
    </body>
    </html>
  `;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}
