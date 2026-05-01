import Foundation
import SwiftUI

class AuthManager: ObservableObject {
    @Published var isAuthenticated = false
    @Published var currentUser: User?
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let baseURL = "https://jobber-pro-app-1e22b180e222.herokuapp.com"

    init() {
        checkAuth()
    }

    func login(email: String, password: String) async {
        await MainActor.run {
            isLoading = true
            errorMessage = nil
        }

        guard let url = URL(string: "\(baseURL)/api/auth/login") else {
            await MainActor.run {
                errorMessage = "Invalid URL"
                isLoading = false
            }
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let loginData = LoginRequest(email: email, password: password)

        do {
            request.httpBody = try JSONEncoder().encode(loginData)

            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw NetworkError.invalidResponse
            }

            if httpResponse.statusCode == 200 {
                // Store session cookie
                if let headerFields = httpResponse.allHeaderFields as? [String: String],
                   let url = response.url {
                    let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: url)
                    HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)
                }

                // Fetch user info
                await fetchCurrentUser()
            } else {
                let errorResponse = try? JSONDecoder().decode([String: String].self, from: data)
                await MainActor.run {
                    errorMessage = errorResponse?["error"] ?? "Login failed"
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func fetchCurrentUser() async {
        guard let url = URL(string: "\(baseURL)/api/auth/me") else { return }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw NetworkError.invalidResponse
            }

            let user = try JSONDecoder().decode(User.self, from: data)

            await MainActor.run {
                self.currentUser = user
                self.isAuthenticated = true
                self.isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = "Failed to fetch user info"
                isLoading = false
            }
        }
    }

    func checkAuth() {
        Task {
            await fetchCurrentUser()
        }
    }

    func logout() async {
        guard let url = URL(string: "\(baseURL)/api/auth/logout") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        do {
            _ = try await URLSession.shared.data(for: request)

            // Clear cookies
            if let cookies = HTTPCookieStorage.shared.cookies {
                for cookie in cookies {
                    HTTPCookieStorage.shared.deleteCookie(cookie)
                }
            }

            await MainActor.run {
                isAuthenticated = false
                currentUser = nil
            }
        } catch {
            print("Logout error: \(error)")
        }
    }
}

enum NetworkError: Error {
    case invalidResponse
    case decodingError
}
