/**
 * WORKER FUNCTIONS (The Employees)
 * These handle the actual logic like DB updates or API calls.
 */
export const workerFunctions = {
  bookAppointment: async (args: { patientName: string; specialty: string; dateTime: string }) => {
    const { patientName, specialty, dateTime } = args;
    // Simulate a database save
    const appointmentId = `PRU-${Math.floor(1000 + Math.random() * 9000)}`;
    
    return {
      success: true,
      displayMessage: `Confirmed! I've booked a ${specialty} appointment for ${patientName} on ${dateTime}. Reference: ${appointmentId}.`,
      data: { appointmentId, status: "scheduled" }
    };
  },

  cancelAppointment: async (args: { appointmentId: string }) => {
    const { appointmentId } = args;
    // Simulate a database deletion
    return {
      success: true,
      displayMessage: `The appointment ${appointmentId} has been successfully cancelled.`,
      data: { appointmentId, status: "cancelled" }
    };
  },

  rescheduleAppointment: async (args: { appointmentId: string; newDateTime: string }) => {
    const { appointmentId, newDateTime } = args;
    return {
      success: true,
      displayMessage: `Appointment ${appointmentId} has been moved to ${newDateTime}.`,
      data: { appointmentId, newDateTime, status: "updated" }
    };
  }
};