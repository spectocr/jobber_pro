import Foundation

class APIService {
    static let shared = APIService()
    private let baseURL = "https://jobber-pro-app-1e22b180e222.herokuapp.com"

    // MARK: - Jobs

    func fetchJobs() async throws -> [Job] {
        guard let url = URL(string: "\(baseURL)/api/jobs") else {
            throw NetworkError.invalidResponse
        }

        let (data, _) = try await URLSession.shared.data(from: url)
        let jobs = try JSONDecoder().decode([Job].self, from: data)
        return jobs
    }

    func updateJobStatus(jobId: String, status: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/jobs/\(jobId)") else {
            throw NetworkError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["status": status]
        request.httpBody = try JSONEncoder().encode(body)

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NetworkError.invalidResponse
        }
    }

    // MARK: - Time Clock

    func fetchTimeEntries() async throws -> [TimeEntry] {
        guard let url = URL(string: "\(baseURL)/api/timeentries") else {
            throw NetworkError.invalidResponse
        }

        let (data, _) = try await URLSession.shared.data(from: url)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let entries = try decoder.decode([TimeEntry].self, from: data)
        return entries
    }

    func clockIn(jobId: String?) async throws -> TimeEntry {
        guard let url = URL(string: "\(baseURL)/api/timeclock/in") else {
            throw NetworkError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: String] = [:]
        if let jobId = jobId {
            body["jobId"] = jobId
        }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NetworkError.invalidResponse
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let entry = try decoder.decode(TimeEntry.self, from: data)
        return entry
    }

    func clockOut() async throws -> TimeEntry {
        guard let url = URL(string: "\(baseURL)/api/timeclock/out") else {
            throw NetworkError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NetworkError.invalidResponse
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let entry = try decoder.decode(TimeEntry.self, from: data)
        return entry
    }

    // MARK: - Photo Upload

    func uploadPhoto(jobId: String, imageData: Data, filename: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/jobs/\(jobId)/attachments") else {
            throw NetworkError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Add image data
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NetworkError.invalidResponse
        }
    }
}
