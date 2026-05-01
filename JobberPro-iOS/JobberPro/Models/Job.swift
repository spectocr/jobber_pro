import Foundation

struct Job: Codable, Identifiable {
    let id: String
    let clientId: String
    let clientName: String?
    let title: String
    let description: String?
    let status: String
    let scheduledDate: String?
    let scheduledTime: String?
    let assignedTo: String?
    let total: Double?
    let address: String?
    let createdAt: Date?

    var statusColor: String {
        switch status {
        case "prospecting": return "gray"
        case "scheduled": return "blue"
        case "in_progress": return "orange"
        case "completed": return "green"
        case "invoiced": return "purple"
        case "bid_lost": return "red"
        default: return "gray"
        }
    }

    var statusIcon: String {
        switch status {
        case "prospecting": return "questionmark.circle"
        case "scheduled": return "calendar"
        case "in_progress": return "hammer.fill"
        case "completed": return "checkmark.circle.fill"
        case "invoiced": return "dollarsign.circle.fill"
        case "bid_lost": return "xmark.circle.fill"
        default: return "circle"
        }
    }

    var formattedTotal: String {
        guard let total = total else { return "$0.00" }
        return String(format: "$%.2f", total)
    }

    var displayDate: String {
        guard let date = scheduledDate, !date.isEmpty else { return "Not scheduled" }
        if let time = scheduledTime, !time.isEmpty {
            return "\(date) at \(time)"
        }
        return date
    }
}

struct JobsResponse: Codable {
    let jobs: [Job]
}
