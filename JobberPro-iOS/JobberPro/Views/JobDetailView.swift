import SwiftUI
import PhotosUI

struct JobDetailView: View {
    let job: Job
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isUploadingPhoto = false
    @State private var showingStatusSheet = false
    @Environment(\.dismiss) var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Status Card
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: job.statusIcon)
                            .font(.title)
                            .foregroundColor(Color(job.statusColor))

                        VStack(alignment: .leading) {
                            Text("Status")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Text(job.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.title3)
                                .fontWeight(.bold)
                        }

                        Spacer()

                        Button(action: {
                            showingStatusSheet = true
                        }) {
                            Text("Update")
                                .font(.subheadline)
                                .fontWeight(.semibold)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(Color(hex: "667eea"))
                                .foregroundColor(.white)
                                .cornerRadius(8)
                        }
                    }
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)

                // Job Details
                VStack(alignment: .leading, spacing: 16) {
                    Text("Details")
                        .font(.headline)

                    DetailRow(icon: "person.fill", label: "Client", value: job.clientName ?? "N/A")
                    DetailRow(icon: "calendar", label: "Scheduled", value: job.displayDate)
                    DetailRow(icon: "mappin.circle.fill", label: "Location", value: job.address ?? "No address")

                    if let total = job.total {
                        DetailRow(icon: "dollarsign.circle.fill", label: "Total", value: job.formattedTotal)
                    }

                    if let description = job.description, !description.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: "doc.text.fill")
                                    .foregroundColor(Color(hex: "667eea"))
                                Text("Description")
                                    .font(.subheadline)
                                    .fontWeight(.semibold)
                            }
                            Text(description)
                                .font(.body)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)

                // Photo Upload Section
                VStack(alignment: .leading, spacing: 12) {
                    Text("Photos")
                        .font(.headline)

                    PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 5, matching: .images) {
                        HStack {
                            Image(systemName: "camera.fill")
                            Text("Add Photos")
                            Spacer()
                            if isUploadingPhoto {
                                ProgressView()
                            } else {
                                Image(systemName: "chevron.right")
                            }
                        }
                        .padding()
                        .background(Color(hex: "667eea"))
                        .foregroundColor(.white)
                        .cornerRadius(12)
                    }
                    .disabled(isUploadingPhoto)
                    .onChange(of: selectedPhotos) { newItems in
                        Task {
                            await uploadPhotos(newItems)
                        }
                    }
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)
            }
            .padding()
        }
        .navigationTitle(job.title)
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $showingStatusSheet) {
            StatusUpdateSheet(job: job, dismiss: dismiss)
        }
    }

    func uploadPhotos(_ items: [PhotosPickerItem]) async {
        isUploadingPhoto = true

        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                do {
                    try await APIService.shared.uploadPhoto(
                        jobId: job.id,
                        imageData: data,
                        filename: "photo_\(Date().timeIntervalSince1970).jpg"
                    )
                } catch {
                    print("Upload failed: \(error)")
                }
            }
        }

        isUploadingPhoto = false
        selectedPhotos = []
    }
}

struct DetailRow: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        HStack {
            Image(systemName: icon)
                .foregroundColor(Color(hex: "667eea"))
                .frame(width: 24)

            Text(label)
                .font(.subheadline)
                .fontWeight(.semibold)
                .frame(width: 80, alignment: .leading)

            Text(value)
                .font(.body)
                .foregroundColor(.secondary)

            Spacer()
        }
    }
}

struct StatusUpdateSheet: View {
    let job: Job
    let dismiss: DismissAction
    @State private var selectedStatus: String
    @State private var isUpdating = false

    let statuses = ["prospecting", "scheduled", "in_progress", "completed"]

    init(job: Job, dismiss: DismissAction) {
        self.job = job
        self.dismiss = dismiss
        _selectedStatus = State(initialValue: job.status)
    }

    var body: some View {
        NavigationView {
            List(statuses, id: \.self) { status in
                Button(action: {
                    selectedStatus = status
                }) {
                    HStack {
                        Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                        Spacer()
                        if selectedStatus == status {
                            Image(systemName: "checkmark")
                                .foregroundColor(Color(hex: "667eea"))
                        }
                    }
                }
            }
            .navigationTitle("Update Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await updateStatus()
                        }
                    }
                    .disabled(isUpdating || selectedStatus == job.status)
                }
            }
        }
    }

    func updateStatus() async {
        isUpdating = true

        do {
            try await APIService.shared.updateJobStatus(jobId: job.id, status: selectedStatus)
            dismiss()
        } catch {
            print("Update failed: \(error)")
        }

        isUpdating = false
    }
}
