import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var authManager: AuthManager

    var body: some View {
        NavigationView {
            List {
                Section {
                    if let user = authManager.currentUser {
                        HStack {
                            Image(systemName: "person.circle.fill")
                                .font(.system(size: 60))
                                .foregroundColor(Color(hex: "667eea"))

                            VStack(alignment: .leading, spacing: 4) {
                                Text(user.name)
                                    .font(.title2)
                                    .fontWeight(.bold)

                                Text(user.email)
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)

                                Text(user.role.capitalized)
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color(hex: "667eea").opacity(0.2))
                                    .foregroundColor(Color(hex: "667eea"))
                                    .cornerRadius(8)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }

                Section("Settings") {
                    NavigationLink(destination: Text("Notifications")) {
                        Label("Notifications", systemImage: "bell.fill")
                    }

                    NavigationLink(destination: Text("Preferences")) {
                        Label("Preferences", systemImage: "gear")
                    }
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0.0")
                            .foregroundColor(.secondary)
                    }

                    Link(destination: URL(string: "https://jobber-pro-app-1e22b180e222.herokuapp.com")!) {
                        Label("Visit Website", systemImage: "globe")
                    }
                }

                Section {
                    Button(action: {
                        Task {
                            await authManager.logout()
                        }
                    }) {
                        HStack {
                            Spacer()
                            Text("Sign Out")
                                .fontWeight(.semibold)
                                .foregroundColor(.red)
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.large)
        }
    }
}
