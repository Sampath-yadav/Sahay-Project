import { Handler, HandlerEvent, HandlerResponse } from '@netlify/functions';
import { supabase } from './lib/supabaseClient';

// Professional headers for standard API interaction
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

/**
 * FEATURE: Hospital Discovery Worker
 * This function serves as the "Menu" for the AI Orchestrator.
 * It dynamically retrieves and deduplicates medical departments.
 */
export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  
  // 1. CORS & Config Guard
  // Standard handling for browser pre-flight and environment verification
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'CORS successful' }) };
  }

  // Safety check to ensure the Supabase client is properly initialized
  if (!supabase) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, message: "Database connection object is uninitialized." }) 
    };
  }

  try {
    // 2. Specific Column Fetching (Categorical Retrieval)
    // We only select the 'specialty' column to keep the payload lightweight and fast.
    const { data, error } = await supabase
      .from('doctors')
      .select('specialty');

    if (error) throw error;

    // Handle case where the table might be empty
    if (!data || data.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          specialties: [], 
          count: 0,
          message: "No specialties currently available in the database." 
        })
      };
    }

    // 3. Data Transformation (In-Memory Deduplication)
    /**
     * FIX: Added explicit type '{ specialty: string }' to the 'doctor' parameter 
     * to resolve TS7006: Parameter 'doctor' implicitly has an 'any' type.
     */
    const rawSpecialties = data.map((doctor: { specialty: string }) => doctor.specialty);
    
    // - new Set() removes duplicates (e.g., 5 Cardiologists -> 1 "Cardiology")
    // - .sort() provides a consistent order for the AI to present to the user
    const uniqueSpecialties = [...new Set(rawSpecialties)].filter((s): s is string => !!s).sort();

    // 4. AI-Friendly Response
    // We return a clear JSON object that the AI Orchestrator can easily parse.
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        specialties: uniqueSpecialties,
        count: uniqueSpecialties.length,
        lastUpdated: new Date().toISOString()
      }) 
    };

  } catch (error: any) {
    // 5. Error Isolation
    // Prevents the AI from "guessing" a list if the database fails.
    console.error("Discovery Worker Error:", error.message);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ 
        success: false, 
        message: "Failed to retrieve real-time specialty menu." 
      }) 
    };
  }
};