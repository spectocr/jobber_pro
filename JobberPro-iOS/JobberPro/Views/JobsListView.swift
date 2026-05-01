import SwiftUI

struct JobsListView: View {
    @State private var jobs: [Job] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedStatus = "All"

    let statuses = ["All", "Prospecting", "Scheduled", "In Progress", "Completed"]

    var filteredJobs: [Job] {
        if selectedStatus == "All" {
            return jobs
        }
        let statusFilter = selectedStatus.lowercased().replacingOccurrences(of: " ", with: "_")
        return jobs.filter { $0.status == statusFilter }
    }

    var body: some View {
        NavigationView {
            VStack {
                // Status Filter
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(statuses, id: \.self) { status in
                            Button(action: {
                                selectedStatus = status
                            }) {
                                Text(status)
                                    .font(.subheadline)
                                    .fontWeight(selectedStatus == status ? .bold : .regular)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 8)
                                    .background(selectedStatus == status ? Color(hex: "667eea") : Color(.systemGray6))
                                    .foregroundColor(selectedStatus == status ? .white : .primary)
                                    .cornerRadius(20)
                            }
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }

                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = errorMessage {
                    VStack {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundColor(.red)
                        Text(error)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Retry") {
                            Task {
                                await loadJobs()
                            }
                        }
                        .padding()
                    }
                } else if filteredJobs.isEmpty {
                    VStack {
                        Image(systemName: "hammer")
                            .font(.system(size: 60))
                            .foregroundColor(.gray)
                        Text("No jobs found")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(filteredJobs) { job in
                        NavigationLink(destination: JobDetailView(job: job)) {
                            JobRowView(job: job)
                        }
                    }
                    .listStyle(PlainListStyle())
                    .refreshable {
                        await loadJobs()
                    }
                }
            }
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        Task {
                            await loadJobs()
                        }
                    }) {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .task {
            await loadJobs()
        }
    }

    func loadJobs() async {
        isLoading = true
        errorMessage = nil

        do {
            jobs = try await APIService.shared.fetchJobs()
            isLoading = false
        } catch {
            errorMessage = "Failed to load jobs"
            isLoading = false
        }
    }
}

struct JobRowView: View {
    let job: Job

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: job.statusIcon)
                .font(.title2)
                .foregroundColor(Color(job.statusColor))
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 4) {
                Text(job.title)
                    .font(.headline)

                if let clientName = job.clientName {
                    Text(clientName)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }

                Text(job.displayDate)
                    .font(.caption)
                    .foregroundColor(.secondary)

                HStack {
                    Text(job.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(job.statusColor).opacity(0.2))
                        .foregroundColor(Color(job.statusColor))
                        .cornerRadius(8)

                    Spacer()

                    if let total = job.total {
                        Text(job.formattedTotal)
                            .font(.subheadline)
                            .fontWeight(.bold)
                            .foregroundColor(Color(hex: "667eea"))
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

extension Color {
    init(_ name: String) {
        switch name {
        case "gray": self = .gray
        case "blue": self = .blue
        case "orange": self = .orange
        case "green": self = .green
        case "purple": self = .purple
        case "red": self = .red
        default: self = .gray
        }
    }
}
