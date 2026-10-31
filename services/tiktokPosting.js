const axios = require('axios');
const fs = require('fs');

async function initInboxVideoUpload({ accessToken, fileSizeBytes }) {
  const response = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSizeBytes,
        chunk_size: fileSizeBytes,
        total_chunk_count: 1,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 30_000,
    }
  );

  return response.data;
}

async function uploadSingleChunk({ uploadUrl, filePath, fileSizeBytes, contentType }) {
  const stream = fs.createReadStream(filePath);
  const lastByte = fileSizeBytes - 1;
  const response = await axios.put(uploadUrl, stream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSizeBytes),
      'Content-Range': `bytes 0-${lastByte}/${fileSizeBytes}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 10 * 60_000,
  });

  return response.status;
}

async function fetchPublishStatus({ accessToken, publishId }) {
  const response = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
    { publish_id: publishId },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 30_000,
    }
  );

  return response.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadVideoToInbox({ accessToken, filePath, contentType = 'video/mp4', pollMax = 20 }) {
  const stat = fs.statSync(filePath);
  const fileSizeBytes = stat.size;
  const initRes = await initInboxVideoUpload({ accessToken, fileSizeBytes });

  const publishId = initRes?.data?.publish_id;
  const uploadUrl = initRes?.data?.upload_url;

  if (!publishId || !uploadUrl) {
    const details = initRes?.error || initRes;
    const err = new Error(`TikTok init failed: ${JSON.stringify(details)}`);
    err.details = initRes;
    throw err;
  }

  await uploadSingleChunk({ uploadUrl, filePath, fileSizeBytes, contentType });

  let lastStatus = null;
  for (let i = 0; i < pollMax; i += 1) {
    await sleep(1500);
    const statusRes = await fetchPublishStatus({ accessToken, publishId });
    const status = statusRes?.data?.status || null;
    lastStatus = { publishId, statusRes, status };

    if (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE') {
      return lastStatus;
    }
    if (status === 'FAILED') {
      const err = new Error(`TikTok publish failed: ${statusRes?.data?.fail_reason || 'unknown'}`);
      err.details = statusRes;
      throw err;
    }
  }

  return lastStatus;
}

module.exports = {
  fetchPublishStatus,
  uploadVideoToInbox,
};

