import { Handler } from '@netlify/functions';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

export const handler: Handler = async () => {
  // This function securely shares only the PUBLIC keys needed for the frontend to render the table
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY
    })
  };
};