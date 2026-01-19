import { Handler } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

// Simplified headers for all responses
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ message: 'CORS preflight successful' }) 
    };
  }

  try {
    // We no longer need to check for process.env or createClient here.
    // The shared 'supabase' object handles the connection logic.
    const { data, error } = await supabase
      .from('doctors')
      .select('specialty');

    if (error) throw error;

    // Use a Set to extract unique specialty names from the results
    const uniqueSpecialties = [...new Set(data?.map(doctor => doctor.specialty))];

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ specialties: uniqueSpecialties }) 
    };
  } catch (error: any) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: error.message }) 
    };
  }
};