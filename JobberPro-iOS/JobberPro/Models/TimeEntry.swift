import Foundation

struct TimeEntry: Codable, Identifiable {
    let id: String
    let userId: String
    let userName: String
    let clockIn: Date
    let clockOut: Date?
    let duration: Int?
    let status: String
    let jobId: String?
    let jobTitle: String?

    var isActive: Bool {
        clockOut == nil
    }

    var durationText: String {
        guard let duration = duration else { return "In Progress" }
        let hours = duration / 3600
        let minutes = (duration % 3600) / 60
        return String(format: "%dh %dm", hours, minutes)
    }

    var formattedClockIn: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: clockIn)
    }

    var formattedClockOut: String {
        guard let clockOut = clockOut else { return "Active" }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: clockOut)
    }
}

struct TimeEntriesResponse: Codable {
    let entries: [TimeEntry]
}
