import SwiftUI

struct TimeClockView: View {
    @State private var activeEntry: TimeEntry?
    @State private var recentEntries: [TimeEntry] = []
    @State private var isLoading = false
    @State private var showingJobPicker = false

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    // Clock In/Out Card
                    VStack(spacing: 20) {
                        if let entry = activeEntry {
                            // Currently Clocked In
                            VStack(spacing: 12) {
                                Image(systemName: "clock.fill")
                                    .font(.system(size: 60))
                                    .foregroundColor(Color(hex: "48bb78"))

                                Text("Clocked In")
                                    .font(.title2)
                                    .fontWeight(.bold)

                                if let jobTitle = entry.jobTitle {
                                    Text(jobTitle)
                                        .font(.headline)
                                        .foregroundColor(.secondary)
                                }

                                Text(entry.formattedClockIn)
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)

                                // Active Duration Timer
                                TimeElapsedView(startTime: entry.clockIn)
                                    .font(.system(size: 48, weight: .bold, design: .monospaced))
                                    .foregroundColor(Color(hex: "667eea"))
                                    .padding()

                                Button(action: {
                                    Task {
                                        await clockOut()
                                    }
                                }) {
                                    HStack {
                                        if isLoading {
                                            ProgressView()
                                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                        } else {
                                            Image(systemName: "stop.fill")
                                            Text("Clock Out")
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding()
                                    .background(Color.red)
                                    .foregroundColor(.white)
                                    .cornerRadius(12)
                                }
                                .disabled(isLoading)
                            }
                        } else {
                            // Ready to Clock In
                            VStack(spacing: 12) {
                                Image(systemName: "clock")
                                    .font(.system(size: 60))
                                    .foregroundColor(.gray)

                                Text("Ready to Clock In")
                                    .font(.title2)
                                    .fontWeight(.bold)

                                Text("Start tracking your time")
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)

                                Button(action: {
                                    Task {
                                        await clockIn()
                                    }
                                }) {
                                    HStack {
                                        if isLoading {
                                            ProgressView()
                                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                        } else {
                                            Image(systemName: "play.fill")
                                            Text("Clock In")
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding()
                                    .background(Color(hex: "48bb78"))
                                    .foregroundColor(.white)
                                    .cornerRadius(12)
                                }
                                .disabled(isLoading)
                            }
                        }
                    }
                    .padding(30)
                    .background(Color(.systemGray6))
                    .cornerRadius(20)

                    // Recent Entries
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Recent Entries")
                            .font(.headline)
                            .padding(.horizontal)

                        if recentEntries.isEmpty {
                            Text("No time entries yet")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .frame(maxWidth: .infinity)
                                .padding()
                        } else {
                            ForEach(recentEntries.prefix(10)) { entry in
                                TimeEntryRow(entry: entry)
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Time Clock")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                await loadTimeEntries()
            }
        }
        .task {
            await loadTimeEntries()
        }
    }

    func loadTimeEntries() async {
        do {
            let entries = try await APIService.shared.fetchTimeEntries()
            recentEntries = entries
            activeEntry = entries.first(where: { $0.isActive })
        } catch {
            print("Failed to load time entries: \(error)")
        }
    }

    func clockIn() async {
        isLoading = true

        do {
            let entry = try await APIService.shared.clockIn(jobId: nil)
            activeEntry = entry
            await loadTimeEntries()
        } catch {
            print("Clock in failed: \(error)")
        }

        isLoading = false
    }

    func clockOut() async {
        isLoading = true

        do {
            _ = try await APIService.shared.clockOut()
            activeEntry = nil
            await loadTimeEntries()
        } catch {
            print("Clock out failed: \(error)")
        }

        isLoading = false
    }
}

struct TimeEntryRow: View {
    let entry: TimeEntry

    var body: some View {
        HStack {
            Image(systemName: entry.isActive ? "clock.fill" : "checkmark.circle.fill")
                .foregroundColor(entry.isActive ? Color(hex: "48bb78") : .gray)

            VStack(alignment: .leading, spacing: 4) {
                if let jobTitle = entry.jobTitle {
                    Text(jobTitle)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                }

                Text(entry.formattedClockIn)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Text(entry.durationText)
                .font(.subheadline)
                .fontWeight(.bold)
                .foregroundColor(Color(hex: "667eea"))
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

struct TimeElapsedView: View {
    let startTime: Date
    @State private var elapsedTime: TimeInterval = 0
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Text(formattedTime)
            .onReceive(timer) { _ in
                elapsedTime = Date().timeIntervalSince(startTime)
            }
            .onAppear {
                elapsedTime = Date().timeIntervalSince(startTime)
            }
    }

    var formattedTime: String {
        let hours = Int(elapsedTime) / 3600
        let minutes = (Int(elapsedTime) % 3600) / 60
        let seconds = Int(elapsedTime) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }
}
