import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ message: 'CORS preflight successful' }) 
    };
  }

  try {
    const { specialty, doctorName } = JSON.parse(event.body || '{}');
    
    // Start building the query using the shared 'supabase' client
    let query = supabase.from('doctors').select('id, name, specialty');

    // Handle flexible specialty search (e.g., "Cardio" matching "Cardiology")
    if (specialty) {
      const searchTerms = specialty.trim().split(/\s+/).join(' | '); 
      query = query.textSearch('specialty', searchTerms, {
        type: 'websearch',
        config: 'english'
      });
    }

    // Handle partial doctor name searches
    if (doctorName) {
      const searchTerms = doctorName.trim().split(/\s+/).join(' & ');
      query = query.textSearch('name', searchTerms, {
        type: 'websearch',
        config: 'english'
      });
    }

    const { data, error } = await query;
    if (error) throw error;

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ doctors: data || [] }) 
    };

  } catch (error: any) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: error.message }) 
    };
  }
};