package app.aethermesh.android

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import app.aethermesh.android.databinding.ItemLogBinding

/**
 * RecyclerView adapter for the Logs tab.
 * Uses DiffUtil for efficient updates so only changed lines re-bind.
 */
class LogAdapter : RecyclerView.Adapter<LogAdapter.LogViewHolder>() {

    private var lines: List<String> = emptyList()

    fun setLines(newLines: List<String>) {
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize() = lines.size
            override fun getNewListSize() = newLines.size
            override fun areItemsTheSame(oldPos: Int, newPos: Int) =
                lines[oldPos] == newLines[newPos]
            override fun areContentsTheSame(oldPos: Int, newPos: Int) =
                lines[oldPos] == newLines[newPos]
        })
        lines = newLines
        diff.dispatchUpdatesTo(this)
    }

    override fun getItemCount() = lines.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): LogViewHolder {
        val binding = ItemLogBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return LogViewHolder(binding)
    }

    override fun onBindViewHolder(holder: LogViewHolder, position: Int) {
        holder.bind(lines[position])
    }

    class LogViewHolder(private val binding: ItemLogBinding) :
        RecyclerView.ViewHolder(binding.root) {
        fun bind(line: String) {
            binding.logLine.text = line
            // Colour-code by severity prefix
            val color = when {
                line.contains("[ERR]", ignoreCase = true) ||
                line.contains("error", ignoreCase = true) -> 0xFFFF6B6B.toInt()
                line.contains("[WARN]", ignoreCase = true) -> 0xFFFFD93D.toInt()
                line.contains("[INFO]", ignoreCase = true) -> 0xFF6BCB77.toInt()
                else -> 0xFFCBD5E1.toInt()
            }
            binding.logLine.setTextColor(color)
        }
    }
}
